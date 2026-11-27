// Abandon handler: scope_abandon.
//
// Plain synchronous function. Interrupts any running scope at exact path
// `target` (never `/` or self) and forces its next turn into `ABANDONED` mode
// where only `scope_return` is bound. Does NOT cascade to other scopes.

import { requestAbandon } from "../scope/forkjoin.mjs";
import { findScopeByPath, normalizeScopePath } from "../scope/path.mjs";
import { decideAbandonRequest } from "./domain/fork-join.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { loadDoc, render } from "../prompts/index.mjs";
import { parseArgs } from "./messages.mjs";
import { ledgerOf } from "./fork-reads.mjs";

const E = loadDoc("errors");

/**
 * Interrupt one running scope and force it to call `scope_return` on its next
 * turn. Idempotent if `abandonRequested` is already true (never interrupts twice).
 */
export function handleAbandonCall(station, call) {
  const ledger = ledgerOf(station);
  if (!ledger) return errorResult("FORK_LEDGER_UNAVAILABLE", E["fork-ledger-unavailable"]);
  const args = parseArgs(call);
  const raw = typeof args?.target === "string" ? args.target.trim() : "";
  const reason =
    typeof args?.reason === "string" && args.reason.trim() !== ""
      ? args.reason.trim()
      : null;
  const callerPath =
    typeof station.selfScopePath === "function" ? station.selfScopePath() : "/";
  const normalized = normalizeScopePath(callerPath, raw, { allowRoot: true });
  if (raw === "" || !normalized.ok) {
    return errorResult(
      "ABANDON_UNKNOWN_TARGET",
      render(E["abandon-unknown-target"], { target: raw }),
    );
  }
  const targetPath = normalized.path;
  const record = targetPath === "/" ? null : findScopeByPath(ledger, targetPath);
  const decision = decideAbandonRequest({
    targetPath,
    callerPath,
    record,
  });
  if (!decision.ok) {
    if (decision.code === "CANNOT_ABANDON_ROOT") {
      return errorResult("CANNOT_ABANDON_ROOT", E["cannot-abandon-root"]);
    }
    if (decision.code === "CANNOT_ABANDON_SELF") {
      return errorResult("CANNOT_ABANDON_SELF", E["cannot-abandon-self"]);
    }
    if (decision.code === "ROLE_ESCALATION") {
      return errorResult(
        "ROLE_ESCALATION",
        render(
          E["role-escalation"] ??
            "Role {callerRole} cannot abandon role {targetRole} ({path}). Privilege narrows monotonically: manager > devops > editor > inspector.",
          {
            callerRole: decision.callerRole ?? "unknown",
            targetRole: decision.targetRole ?? "unknown",
            path: decision.path ?? targetPath,
          },
        ),
        {
          target: decision.path ?? targetPath,
          callerRole: decision.callerRole,
          targetRole: decision.targetRole,
        },
      );
    }
    if (decision.code === "SCOPE_ALREADY_DONE") {
      return errorResult(
        "SCOPE_ALREADY_DONE",
        render(E["scope-already-done"], { target: record?.path ?? targetPath }),
      );
    }
    return errorResult(
      "ABANDON_UNKNOWN_TARGET",
      render(E["abandon-unknown-target"], { target: targetPath }),
    );
  }

  const exactPath = record.path ?? targetPath;
  if (decision.alreadyAbandoning) {
    return textResult(
      `Scope ${exactPath} is already winding down to scope_return.`,
      {
        result: {
          ok: true,
          target: exactPath,
          alreadyAbandoning: true,
        },
      },
    );
  }

  const req = requestAbandon(ledger, record.forkId, { by: callerPath, reason });
  if (!req.ok) {
    return errorResult(req.code, req.reason);
  }
  if (typeof station.persistLedger === "function") station.persistLedger();
  else if (typeof station.persist === "function") station.persist();

  // Tail position: interrupt the target's live session (never USER_ABORT).
  station.interruptScopePort?.(record.forkId);

  return textResult(
    `Abandoned ${exactPath}${reason ? ` (${reason})` : ""}; awaiting its scope_return.`,
    {
      result: {
        ok: true,
        target: exactPath,
      },
    },
  );
}
