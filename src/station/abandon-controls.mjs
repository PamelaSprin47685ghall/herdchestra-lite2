// Abandon handler: scope_abandon.
//
// Plain synchronous function. One running child is closed as failed so a
// parked join takes it; its descendants close with it.

import { abandon, abandonDescendants, forkOf, markReady } from "../scope/forkjoin.mjs";
import { findScopeByPath, normalizeScopePath } from "../scope/path.mjs";
import { notifyWaiters, pulse, setOutcome } from "../scope/fork-registry.mjs";
import { rejectPendingRequests } from "../scope/request-queue.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { parseArgs } from "./messages.mjs";
import { forkRegistryOf } from "./ports-contract.mjs";
import { ledgerOf, ownerIdOf } from "./fork-reads.mjs";

const F = loadDoc("tools/fork-join");
const E = loadDoc("errors");

/**
 * Close one child that will not return.
 *
 * `scope_abandon({ target })` names one exact path under this scope. The
 * bracket closes as failed (a running child becomes ready-with-failure, so a
 * parked join takes it), its descendants close with it, its agent stops, its
 * queued requests reject, and the registry wakes every waiter. The record is
 * kept: the join still reports what happened.
 */
export function handleAbandonCall(station, call) {
  const ledger = ledgerOf(station);
  if (!ledger) return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  const args = parseArgs(call);
  const raw = typeof args?.target === "string" ? args.target.trim() : "";
  const callerPath =
    typeof station.selfScopePath === "function" ? station.selfScopePath() : "/";
  const normalized = normalizeScopePath(callerPath, raw);
  if (raw === "" || !normalized.ok) {
    return errorResult(
      "ABANDON_UNKNOWN_TARGET",
      render(E["abandon-unknown-target"], { target: raw }),
    );
  }
  const record = findScopeByPath(ledger, normalized.path);
  if (!record) {
    return errorResult(
      "ABANDON_UNKNOWN_TARGET",
      render(E["abandon-unknown-target"], { target: normalized.path }),
    );
  }
  if (record.ownerId !== ownerIdOf(station)) {
    return errorResult(
      "ABANDON_NOT_OWNED",
      render(E["abandon-not-owned"], { target: normalized.path }),
    );
  }
  const reason = `abandoned by ${callerPath}`;
  const subtree = abandonDescendants(ledger, record.forkId, reason);
  if (record.status === "running") {
    // A parked join takes only a ready record, so a running child closes as
    // ready-with-failure; the outcome says it was abandoned.
    markReady(ledger, record.forkId, { ok: false, reason, record: "" });
  } else {
    abandon(ledger, record.forkId, reason);
  }
  const registry = forkRegistryOf(station);
  if (registry) {
    setOutcome(registry, record.forkId, { failed: true, reason, record: "" });
    rejectPendingRequests(registry, normalized.path, reason);
    pulse(registry, ledger, record.forkId, { failed: true, reason, record: "" });
    notifyWaiters(registry);
  }
  // The target stops too: its own agent may be the one that never returns.
  const liveIds = [
    record.forkId,
    ...(subtree.runningIds ?? []),
    ...(subtree.liveIds ?? []),
  ];
  station.abortChildrenPort?.(liveIds, subtree.abandonedIds ?? [], liveIds);
  const closed = Array.isArray(subtree.abandonedIds) ? subtree.abandonedIds : [];
  return textResult(render(F["abandon.tool"], { path: normalized.path }), {
    result: {
      ok: true,
      abandoned: [
        normalized.path,
        ...closed.map((forkId) => {
          const child = forkOf(ledger, forkId);
          return child?.path ?? forkId;
        }),
      ],
    },
  });
}
