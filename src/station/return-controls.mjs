// Return handlers: scope_return, for Root and Child alike.
//
// Plain synchronous function. The decision is pure (`decideScopeReturn`), the
// bracket mutations go through the ledger, and the host receives a stop signal
// through `stopLoop`.

import {
  adoptFork,
  forkOf,
  liveReceiverOf,
  markReady,
  openChildren,
  readyChildren,
  reparentOrphans,
  unreceivedChildren,
} from "../scope/forkjoin.mjs";
import { setRecordFields } from "../scope/record-mutation.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { toolCalls } from "../transcript/messages.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { decideReady, decideReturn } from "./domain/fork-join.mjs";
import { decideScopeReturn, formatGenerationReport } from "./domain/handoff.mjs";
import { parseArgs } from "./messages.mjs";
import { childRecordStart, frameOf, identityOf, ledgerOf } from "./fork-reads.mjs";

const F = loadDoc("tools/fork-join");
const E = loadDoc("errors");

const messagesOf = (station) =>
  typeof station.contextMessages === "function" ? station.contextMessages() : [];

/**
 * Close or rewind the current scope through `scope_return`.
 *
 * Unified across Root (depth 0) and Child (depth >= 1):
 * - Oath `unfinished` -> small handoff rewind (`stopLoop: true`) back to birth.
 * - Oath `a_ferocious_audacious_master_would_change_nothing` -> Child seals and
 *   delivers to parent (`stopLoop: true`);
 *   Root #1 rewinds for independent review (`stopLoop: true`);
 *   Root #2 consecutive promotes without rewind (`stopLoop: false`).
 * - A missing or other oath value -> `INVALID_RETURN_OATH`; there is no default.
 * - Woken child -> `dafny` forwards to `..`; the parent receives it as a new
 *   `scope_request` and no second return is invented.
 */
export function handleReturnCall(station, call, options = {}) {
  const args = parseArgs(call);
  const identity = identityOf(station);
  const selfForkId =
    identity && typeof identity.forkId === "string" ? identity.forkId : "";
  const isRoot = selfForkId === "";
  const ledger = ledgerOf(station);
  if (!isRoot && !ledger) {
    return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  }
  const record = !isRoot && ledger ? forkOf(ledger, selfForkId) : null;
  const orphans = !isRoot && record
    ? [...openChildren(ledger, selfForkId), ...readyChildren(ledger, selfForkId)]
    : [];
  const receiverId = !isRoot && record ? liveReceiverOf(ledger, record.ownerId ?? "") : "";
  const unreceived = isRoot && ledger ? unreceivedChildren(ledger, "root").length : 0;

  // Reject any mixed batch that pairs `scope_return` with other tool calls in
  // the same assistant message, so sibling tools cannot race loop termination
  // or a rewind boundary.
  const carrying = options.currentMessage ?? null;
  const callsInBeat = carrying ? toolCalls(carrying) : [];
  const mixedToolCalls =
    callsInBeat.length > 1 &&
    callsInBeat.some((entry) => entry.id !== frameOf(call));

  // Root rewinds require a real host session/manager capable of persisting the
  // compaction boundary. If the host explicitly reports `canRewindRoot(ctx) === false`,
  // refuse before mutating state so Root never lands in a stranded pendingRewind.
  const canRewindFn = station.host?.session?.canRewindRoot;
  const canRewindRoot =
    typeof canRewindFn === "function"
      ? canRewindFn(options.ctx) === true
      : Boolean(station.manager && typeof station.manager.appendCompaction === "function");

  const decision = decideScopeReturn({
    isRoot,
    identityForkId: selfForkId,
    record,
    receiverId,
    orphans,
    unreceived,
    relay: station.state?.relay ?? null,
    review: station.state?.features?.review ?? "on",
    canRewindRoot,
    mixedToolCalls,
    args,
    callId: typeof call?.id === "string" ? call.id : "",
  });

  if (!decision.ok) {
    if (decision.code === "INVALID_RETURN_OATH") {
      return errorResult("INVALID_RETURN_OATH", E["invalid-return-oath"]);
    }
    if (decision.code === "MISSING_DAFNY") {
      return errorResult("MISSING_DAFNY", E["missing-dafny"]);
    }
    if (decision.code === "MIXED_RETURN_TOOL_CALLS") {
      return errorResult("MIXED_RETURN_TOOL_CALLS", E["mixed-return"]);
    }
    if (decision.code === "UNRECEIVED_CHILDREN") {
      return errorResult(
        "UNRECEIVED_CHILDREN",
        render(E["return-unreceived"], { count: decision.unreceived }),
        { unreceived: decision.unreceived },
      );
    }
    if (decision.code === "ROOT_REWIND_UNAVAILABLE") {
      return errorResult("ROOT_REWIND_UNAVAILABLE", E["return-rewind-unavailable"]);
    }
    if (decision.code === "NOT_A_CHILD") {
      return errorResult("NOT_A_CHILD", E["not-a-child"]);
    }
    if (decision.code === "UNKNOWN_FORK") {
      return errorResult("UNKNOWN_FORK", E["unknown-fork"]);
    }
    if (decision.code === "FORK_NOT_RUNNING") {
      return errorResult("FORK_NOT_RUNNING", render(E["fork-not-running"], {
        scopeId: publicScopeId(record),
        status: decision.status,
      }));
    }
    return errorResult("ORPHANS_WITHOUT_RECEIVER", E["orphans-without-receiver"]);
  }

  // Child small handoff: keep bracket RUNNING, capture formatted generation
  // report, and let the spawn ticket rewind back to `originEntryId` after the
  // agent loop stops cleanly via `stopLoop: true`.
  if (decision.kind === "rewind" && decision.scope === "child") {
    const canRewindChild =
      station.childRewindAvailable !== false &&
      typeof station.manager?.branch === "function" &&
      typeof station.manager?.resetLeaf === "function";
    if (!canRewindChild) {
      return errorResult("ROOT_REWIND_UNAVAILABLE", E["return-rewind-unavailable"]);
    }
    const messages = messagesOf(station);
    const report = formatGenerationReport(
      messages,
      childRecordStart(messages, record),
      decision.dafny,
    );
    const generation =
      (Number.isInteger(record.handoffCount) && record.handoffCount >= 0 ? record.handoffCount : 0) + 1;
    setRecordFields(record, { handoffCount: generation });
    station.pendingChildRewind = {
      report,
      big: false,
      generation,
      id: typeof call?.id === "string" ? call.id : "",
    };
    return textResult(
      render(F["return.rewind"], { generation }),
      {
        forkId: selfForkId,
        scopeId: publicScopeId(record),
        accepted: true,
        rewind: true,
        generation,
        stopLoop: true,
      },
    );
  }

  // Root promotion (2nd consecutive big handoff): allow final answer in place.
  if (decision.kind === "promote") {
    station.state.relay = decision.relay;
    return textResult(F["return.finish"], {
      scope: "root",
      accepted: true,
      promoted: true,
      bigStreak: decision.relay.bigStreak,
      canStop: true,
      stopLoop: false,
    });
  }

  // Root rewind (small handoff or 1st big handoff): format this generation's
  // record + dafny, persist `pendingRewind` on `state.relay`, and stop the
  // loop cleanly so `onAgentEnd` dispatches the host rewind ticket.
  if (decision.kind === "rewind" && decision.scope === "root") {
    const messages = messagesOf(station);
    const report = formatGenerationReport(messages, 0, decision.dafny);
    const pendingRewind = {
      ...decision.pendingRewind,
      report,
    };
    station.state.relay = {
      ...decision.relay,
      pendingRewind,
    };
    const template = decision.big ? F["return.review"] : F["return.rewind"];
    return textResult(
      render(template, { generation: pendingRewind.generation }),
      {
        scope: "root",
        accepted: true,
        rewind: true,
        big: decision.big,
        generation: pendingRewind.generation,
        stopLoop: true,
        result: {
          ok: true,
          scope: "root",
          rewind: true,
          sealed: false,
          big: decision.big,
          generation: pendingRewind.generation,
        },
      },
    );
  }

  // Child seal handoff: seal the bracket and deliver to receiver.
  // Keep `decideReturn` assertion for the pure fork-join gate contract.
  const gate = decideReturn({
    identityForkId: selfForkId,
    record,
    receiverId: decision.receiverId,
    orphans: decision.orphans,
  });
  if (!gate.ok) {
    return errorResult(gate.code, E["orphans-without-receiver"]);
  }
  const adopted = adoptFork(ledger, selfForkId, decision.receiverId);
  if (!adopted.ok) return errorResult(adopted.code, adopted.reason);

  let renderedRecord = null;
  if (station.setChildOutcome) {
    const messages = messagesOf(station);
    renderedRecord = formatGenerationReport(
      messages,
      childRecordStart(messages, record),
      decision.dafny,
    );
    station.setChildOutcome(selfForkId, {
      record: renderedRecord,
      failed: false,
      reason: null,
    });
  }

  const readyDecision = decideReady({
    record,
    outcome:
      renderedRecord === null ? { ok: true } : { ok: true, record: renderedRecord },
  });
  if (!readyDecision.ok) {
    return errorResult(
      readyDecision.code,
      readyDecision.code === "FORK_NOT_RUNNING"
        ? render(E["fork-not-running"], {
            scopeId: publicScopeId(record),
            status: readyDecision.status,
          })
        : E["unknown-fork"],
    );
  }
  const ready = markReady(ledger, selfForkId, readyDecision.outcome);
  if (!ready.ok) return errorResult(ready.code, ready.reason);
  if (decision.orphans.length > 0) reparentOrphans(ledger, selfForkId, decision.receiverId);

  let persisted = true;
  if (typeof station.persistLedger === "function") {
    persisted = station.persistLedger() !== false;
  }
  if (!persisted) {
    station.noteError?.("fork", new Error("ready record was not persisted"), {
      forkId: selfForkId,
      phase: "return",
    });
  }
  const receiverText =
    decision.receiverId === "root"
      ? "Root"
      : publicScopeId(forkOf(ledger, decision.receiverId));
  const lines = [`Sealed ${publicScopeId(record)}; delivered to ${receiverText}.`];
  if (decision.orphans.length > 0) {
    lines.push(
      `Reparented to ${receiverText}: ${decision.orphans.map((id) => publicScopeId(forkOf(ledger, id))).join(", ")}.`,
    );
  }
  if (!persisted) {
    lines.push(
      "Persistence warning: this ready record exists in memory, but the shared tree was not written.",
    );
  }
  return textResult(lines.join("\n"), {
    forkId: selfForkId,
    scopeId: publicScopeId(record),
    returned: true,
    reparented: decision.orphans,
    receiver: decision.receiverId,
    receiverText,
    accepted: true,
    stopLoop: true,
    result: {
      ok: true,
      scope: publicScopeId(record),
      sealed: true,
      receiver: receiverText,
      reparented: decision.orphans.map((id) => publicScopeId(forkOf(ledger, id))),
      persisted,
    },
  });
}
