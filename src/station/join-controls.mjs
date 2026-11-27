// Join handlers: scope_join.
//
// Plain synchronous functions. A join takes one ready child through the port,
// admits it against the next model window, and renders the child's own record.

import { forkOf, releaseRecordText, takeReady, unreceivedChildren } from "../scope/forkjoin.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { joinReceipt } from "../transcript/replay.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import {
  admitJoin,
  frameOf,
  ledgerOf,
  levelKeyOf,
  ownerIdOf,
} from "./fork-reads.mjs";

const E = loadDoc("errors");

export function handleJoinCall(station, call, options = {}) {
  const ledger = ledgerOf(station);
  if (!ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  }
  const ownerId = ownerIdOf(station);
  // With nothing running and nothing ready, no join can succeed. Answering
  // before the report gate keeps the model out of a loop that demands a
  // summary for a receipt no later join could ever archive.
  if (unreceivedChildren(ledger, ownerId).length === 0) {
    return errorResult("NO_READY_CHILD", E["no-ready-child"], {
      ownerId,
      active: 0,
      pending: null,
    });
  }
  // A reparented child closes at the receiver's level, not at the level of
  // the branch that gave birth to it. The explicit key is what puts it in the
  // grandparent's sibling chain. Admission runs before the take, so a record
  // the next request cannot hold stays ready and unconsumed.
  const taken = takeReady(ledger, {
    ownerId,
    levelKey: levelKeyOf(station),
    admit: (candidate) => admitJoin(station, candidate, options),
  });
  if (!taken.ok) {
    if (taken.code === "NO_ADMISSIBLE_CHILD") {
      const first = taken.blocked?.[0] ?? null;
      const detail = first
        ? `Fork ${publicScopeId(forkOf(ledger, first.forkId))} cannot be delivered: ${first.reason ?? "the next request would exceed the model window"}.`
        : "No ready scope fits the model window.";
      return errorResult(
        "JOIN_CONTEXT_EXCEEDED",
        render(E["join-context-exceeded"], { detail }),
        {
          ownerId,
          active: unreceivedChildren(ledger, ownerId).length,
          blocked: taken.blocked ?? [],
        },
      );
    }
    return errorResult("NO_READY_CHILD", E["no-ready-child"], {
      ownerId,
      active: unreceivedChildren(ledger, ownerId).length,
    });
  }
  const persisted = confirmJoinPersistence(station);
  if (persisted === false) {
    station.noteError?.("fork", new Error("join receipt was not persisted"), {
      forkId: taken.fork.forkId,
      phase: "join",
    });
  }
  return renderJoinResult(station, taken.fork, {
    ledger,
    ownerId,
    closeToolCallId: frameOf(call),
    persisted,
  });
}

/**
 * Confirm a just-filed join receipt reached the shared tree.
 *
 * `persist()` is the station's durable-write signal: false means the receipt
 * exists in memory but the tree was not written. A station double without the
 * method is not judged, so handlers that never wire persistence keep their
 * old result shape.
 */
export function confirmJoinPersistence(station) {
  if (typeof station.persist !== "function") return undefined;
  return station.persist() !== false;
}

/**
 * Render a record the caller already took. The waiting ticket takes the child
 * inside waitForReady, so it must not take again: a second take would find an
 * empty queue and report a failure for a join that already succeeded.
 */
export function renderJoinResult(station, record, options = {}) {
  const ledger = options.ledger ?? ledgerOf(station);
  const ownerId = options.ownerId ?? ownerIdOf(station);
  const remaining = unreceivedChildren(ledger, ownerId).map((id) => ({
    forkId: id,
    scopeId: publicScopeId(forkOf(ledger, id)),
  }));
  // The child's finished record lives in the outcome table, written when the
  // branch stopped. Rendering its messages again here would either duplicate
  // that work or, for a spawner that wrote no messages, hand the parent an
  // empty record. The message path stays as a fallback for direct handlers.
  const outcome = station.childOutcomePort?.(record.forkId) ?? null;
  // The record is frozen by the child's own return. A missing record means the
  // child produced no visible work; it is reported as empty instead of being
  // re-rendered from an array the ledger never carried.
  const rendered =
    typeof record.record === "string"
      ? record.record
      : typeof outcome?.record === "string"
        ? outcome.record
        : "";
  const childFailed = record.outcome === "failed" || outcome?.failed === true;
  const childReason = record.reason ?? outcome?.reason ?? null;
  const text = joinReceipt({
    forkId: publicScopeId(record),
    record: rendered,
    failed: childFailed,
    reason: childReason,
    remaining: remaining.map((entry) => entry.scopeId),
  });
  // The body has now been read for the last time. Render it above, then hand
  // it back: a delivered record has no reader after this receipt, and keeping
  // it makes every later ledger baseline re-serialize the whole transcript.
  // `renderJoinResult` runs before the station persists the join, so the write
  // that follows already carries the smaller record.
  //
  // The release is conditional on the outcome table still holding the text, so
  // a second render of the same join reproduces the identical receipt instead
  // of an empty one. When the table has no copy there is nothing to fall back
  // on, and the body stays: a correct receipt outranks a smaller write.
  if (
    typeof record.record === "string" &&
    typeof outcome?.record === "string"
  ) {
    releaseRecordText(ledger, record.forkId);
  }
  const persisted = options.persisted;
  const notes = [];
  if (persisted === false) {
    notes.push(
      "Persistence warning: this join receipt exists in memory, but the shared tree was not written.",
    );
  }
  const body = notes.length === 0 ? text : `${text}${text.endsWith("\n") ? "" : "\n"}${notes.join("\n")}`;
  return textResult(body, {
    forkId: record.forkId,
    joined: true,
    remaining,
    ...(persisted === undefined ? {} : { persisted }),
    result: {
      ok: !childFailed,
      scope: publicScopeId(record),
      failed: childFailed,
      reason: childReason,
      record: rendered,
      note: "History only; do not re-execute it.",
      unreceived: remaining.map((entry) => entry.scopeId),
      persisted: persisted !== false,
    },
  });
}
