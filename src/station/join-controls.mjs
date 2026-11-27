// Join handlers: scope_join.
//
// Plain synchronous functions. A join takes one ready subscope through the port,
// admits it against the next model window, and renders the subscope's own record.

import { forkOf } from "../scope/ledger-charge.mjs";
import { releaseRecordText, takeReady, unreceivedChildren } from "../scope/ledger-brackets.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { joinReceipt } from "../transcript/replay.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import {
  admitJoin,
  frameOf,
  joinEnvelope,
  ledgerOf,
  levelKeyOf,
  ownerIdOf,
} from "./fork-reads.mjs";
import { processedOf } from "./domain/tool-call-ledger.mjs";

const E = loadDoc("errors");

export function handleJoinCall(station, call, options = {}) {
  const ledger = ledgerOf(station);
  if (!ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  }
  const ownerId = ownerIdOf(station);
  if (unreceivedChildren(ledger, ownerId).length === 0) {
    return errorResult("NO_READY_CHILD", E["no-ready-subscope"], {
      ownerId,
      active: 0,
      pending: null,
    });
  }
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
    return errorResult("NO_READY_CHILD", E["no-ready-subscope"], {
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

export function confirmJoinPersistence(station) {
  if (typeof station.persist !== "function") return undefined;
  return station.persist() !== false;
}

/**
 * Finish a join whose record was already taken by the waiting ticket.
 *
 * This is the one place a join is committed: persistence is confirmed, the
 * receipt is rendered, the call is marked answered so a replay is a no-op, and
 * the state is written. Both the synchronous call path and the waiting ticket
 * end here; a second copy of these five steps would let them drift.
 */
export function finalizeJoinRecord(station, toolCallId, record, frameId) {
  const persisted = confirmJoinPersistence(station);
  if (persisted === false) {
    station.noteError?.("fork", new Error("join receipt was not persisted"), {
      forkId: record.forkId,
      phase: "join",
    });
  }
  const result = renderJoinResult(station, record, {
    closeToolCallId: frameId ?? toolCallId,
    persisted,
  });
  const processed = processedOf(station);
  processed?.setHandled?.(toolCallId, result);
  processed?.markCall?.(toolCallId);
  station.persist();
  return result;
}

export function renderJoinResult(station, record, options = {}) {
  // One envelope, read exactly the way admission priced it. A receipt rendered
  // from a second reading could differ from the one the window admitted.
  const envelope = joinEnvelope(station, record, {
    ledger: options.ledger,
    ownerId: options.ownerId,
  });
  const remaining = envelope.remaining;
  const rendered = envelope.record;
  const childFailed = envelope.failed;
  const abandoned = envelope.abandoned;
  const abandonedBy = envelope.abandonedBy;
  const abandonReason = envelope.abandonReason;
  const childReason = envelope.reason;
  const text = joinReceipt({
    forkId: publicScopeId(record),
    record: rendered,
    failed: childFailed,
    abandoned,
    abandonedBy,
    abandonReason,
    reason: childReason,
    remaining: remaining.map((entry) => entry.scopeId),
  });
  if (envelope.releasesRecord) releaseRecordText(envelope.ledger, record.forkId);
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
      ...(record.role ? { role: record.role } : {}),
      ...(abandoned ? { abandoned: true, abandonedBy, abandonReason } : {}),
      reason: childReason,
      record: rendered,
      note: "History only; do not re-execute it.",
      unreceived: remaining.map((entry) => entry.scopeId),
      persisted: persisted !== false,
    },
  });
}
