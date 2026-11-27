// Pure abandon gates. Ledger mutations live in scope/ledger-brackets.mjs.
//
// Two distinct operations:
// 1. `decideAbandonRequest` (`scope_abandon` tool): interrupts any running
//    subscope at an exact path (never `/` or self) and forces its next turn to
//    call `scope_return` without rewinding. Idempotent if already abandoning.
// 2. `decideAbandon` (hard Esc/User-abort cascade): closes a bracket directly as
//    FAILED when the user aborts the conversation tree.

import { canActOn, roleOfPath } from "./roles.mjs";

/** Interrupt reason for `scope_abandon`, distinct from `USER_ABORT` and `TOOL_INTERRUPT_ABORT_REASON`. */
export const ABANDON_INTERRUPT_REASON = Symbol.for("herdchestra-lite2.scope-abandon-interrupt.v1");

/** Hard cascade close gate (used by `abandon()` for User Abort / Esc). */
export function decideAbandon({ record = null } = {}) {
  if (!record || typeof record !== "object") {
    return { ok: false, code: "UNKNOWN_FORK" };
  }
  if (record.status === "joined") {
    return { ok: false, code: "FORK_ALREADY_JOINED" };
  }
  return { ok: true, status: "failed" };
}

/** Graceful `scope_abandon` gate for any running subscope. */
export function decideAbandonRequest({
  targetPath = "",
  callerPath = "/",
  callerRole = null,
  record = null,
} = {}) {
  if (targetPath === "/") {
    return { ok: false, code: "CANNOT_ABANDON_ROOT" };
  }
  if (!record || typeof record !== "object") {
    return { ok: false, code: "ABANDON_UNKNOWN_TARGET" };
  }
  if (
    typeof callerPath === "string" &&
    callerPath !== "/" &&
    typeof record.path === "string" &&
    record.path.toLowerCase() === callerPath.toLowerCase()
  ) {
    return { ok: false, code: "CANNOT_ABANDON_SELF" };
  }
  const effectiveCallerRole = callerRole ?? roleOfPath(callerPath);
  const targetRole = roleOfPath(typeof record.path === "string" ? record.path : targetPath);
  if (effectiveCallerRole && targetRole && !canActOn(effectiveCallerRole, targetRole)) {
    return {
      ok: false,
      code: "ROLE_ESCALATION",
      callerRole: effectiveCallerRole,
      targetRole,
      path: record.path ?? targetPath,
    };
  }
  if (record.status !== "running") {
    return { ok: false, code: "SCOPE_ALREADY_DONE" };
  }
  if (record.abandonRequested === true) {
    return { ok: true, alreadyAbandoning: true, record };
  }
  return { ok: true, alreadyAbandoning: false, record };
}
