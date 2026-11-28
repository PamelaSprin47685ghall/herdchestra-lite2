// Return handlers: scope_return, for Root and Child alike.
//
// Plain synchronous function. The decision is pure (`decideScopeReturn`), the
// bracket mutations go through the ledger, and the host receives a stop signal
// through `stopLoop`.

import { forkOf } from "../scope/ledger-charge.mjs";
import {
  adoptFork,
  liveReceiverOf,
  markReady,
  openChildren,
  readyChildren,
  reparentOrphans,
  unreceivedChildren,
} from "../scope/ledger-brackets.mjs";
import { setRecordFields } from "../scope/record-mutation.mjs";
import { publicScopeId } from "../scope/scope-id.mjs";
import { toolCalls } from "../transcript/messages.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { refusal } from "./errors.mjs";
import { decideReady, decideReturn } from "./domain/fork-join.mjs";
import { decideScopeReturn, formatGenerationReport } from "./domain/handoff.mjs";
import { parseArgs } from "./messages.mjs";
import { childRecordStart, frameOf, identityOf, ledgerOf } from "./fork-reads.mjs";

const E = loadDoc("errors");

const messagesOf = (station) =>
  typeof station.contextMessages === "function" ? station.contextMessages() : [];

/**
 * Close or rewind the current scope through `scope_return`.
 *
 * Unified across Root (depth 0) and Child (depth >= 1):
 * - Oath `unfinished` -> small handoff rewind (`stopLoop: true`) back to birth.
 * - Oath `a_ferocious_audacious_master_would_change_nothing` -> Child seals and
 *   delivers to parent (`stopLoop: true`); Root promotes without a rewind
 *   (`stopLoop: false`) and writes the final answer.
 * - A missing or other oath value -> `INVALID_RETURN_OATH`; there is no default.
 * - Woken child -> `dafny` forwards to `..`; the parent receives it as a new
 *   `scope_join` and no second return is invented.
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
    canRewindRoot,
    mixedToolCalls,
    args,
    callId: typeof call?.id === "string" ? call.id : "",
  });

  if (!decision.ok) {
    const denied = refusal(decision, { record });
    return errorResult(denied.code, denied.message, denied.details);
  }

  // Child small handoff: keep bracket RUNNING, capture formatted generation
  // report, and let the spawn ticket rewind back to `originEntryId` after the
  // agent loop stops cleanly via `stopLoop: true`.
  if (decision.kind === "rewind" && decision.scope === "child") {
    if (!station.isChildRewindPermitted()) {
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
    station.stageChildRewind({
      report,
      big: false,
      generation,
      id: typeof call?.id === "string" ? call.id : "",
    });
    return textResult("scope_return processed.", {
      stopLoop: true,
      result: { rewind: true, generation },
    });
  }

  // Root promotion (seal): allow the final answer in place, same as a child
  // seal ends the child's work.
  if (decision.kind === "promote") {
    station.state.relay = decision.relay;
    return textResult("scope_return processed.", {
      result: { promoted: true },
    });
  }

  // Root rewind (small handoff): format this generation's record + dafny,
  // persist `pendingRewind` on `state.relay`, and stop the loop cleanly so
  // `onAgentEnd` dispatches the host rewind ticket.
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
    return textResult("scope_return processed.", {
      scope: "root",
      rewind: true,
      stopLoop: true,
      result: {
        big: decision.big,
        generation: pendingRewind.generation,
      },
    });
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
  const isAbandoned = decision.abandoned === true;
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
      abandoned: isAbandoned,
      abandonedBy: record.abandonedBy ?? null,
      abandonReason: record.abandonReason ?? null,
      reason: null,
    });
  }

  const readyDecision = decideReady({
    record,
    outcome:
      renderedRecord === null
        ? { ok: true, abandoned: isAbandoned }
        : { ok: true, abandoned: isAbandoned, record: renderedRecord },
  });
  if (!readyDecision.ok) {
    return errorResult(
      readyDecision.code,
      readyDecision.code === "FORK_NOT_RUNNING"
        ? render(E["fork-not-running"], {
            path: publicScopeId(record),
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
  const receiverRecord =
    decision.receiverId === "root" ? null : forkOf(ledger, decision.receiverId);
  const receiverText =
    decision.receiverId === "root"
      ? "Root"
      : receiverRecord
        ? publicScopeId(receiverRecord)
        : decision.receiverId;
  return textResult("scope_return processed.", {
    stopLoop: true,
    result: {
      scope: publicScopeId(record),
      sealed: true,
      ...(isAbandoned ? { abandoned: true } : {}),
      receiver: receiverText,
      reparented: decision.orphans.map((id) => publicScopeId(forkOf(ledger, id))),
      persisted,
    },
  });
}
