// Scope accounting: branch charging and host boundaries.
//
// Every function mutates the state object it receives. No I/O.
//
// There is no refund path. A refund existed to undo one amended beat, and
// `amend` is gone: a beat that ran stays charged, and the only way to spend
// less is to call less. `spent` and `remaining` on the fork record are the
// whole account.

import { failure } from "./state.mjs";
import { beatShares, isFreeTool, isFreeCall, normalizeToolName, roundAmount } from "./turns.mjs";
import { notePanhandled } from "./panhandle.mjs";
import { applyCharge, forkOf } from "./forkjoin.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

const E = loadDoc("errors");

/**
 * Charge one tool call against the branch that owns it.
 *
 * A branch's budget exists only on its fork record. The root has no fork
 * record, so it has no budget: an ordinary tool is refused there and the work
 * must be delegated with `scope_fork`. A forked branch spends its own fork
 * record, never the parent's. Free calls (the control plane, `ask`, `wait`, and
 * a `read` or `write` of a built-in protocol URI) pass at every level.
 *
 * The station settles a whole js beat in one `finishJsCall`, and its handled
 * set refuses a repeated dispatch, so a charge is spent once by construction.
 */
export function chargeBranch(_state, ledger, params = {}) {
  const { ownerId, toolCallId, toolName, groupKey, beatTools, input } = params;
  if (isFreeCall(toolName, input)) return { ok: true, free: true };
  const record = ownerId && ledger ? forkOf(ledger, ownerId) : null;
  if (!record) {
    if (!ownerId) {
      return failure("ROOT_HAS_NO_BUDGET", E["root-has-no-budget"]);
    }
    return failure(
      "NO_BRANCH_BUDGET",
      render(E["no-branch-budget"], { ownerId }),
    );
  }
  const tool = normalizeToolName(toolName);
  // One beat spends one turn however its calls divide (`CHARGE_SCALE` in
  // turns.mjs). `beatShares` prices this tool's share of that turn, so each of
  // its calls pays the share over the number of calls of that tool. Charging
  // the whole share per call spent three turns for a beat with three reads.
  const entries = Array.isArray(beatTools) ? beatTools : [];
  const share = entries.length > 0 ? beatShares(entries)[tool] ?? 1 : 1;
  const callsOfTool = entries.reduce((count, entry) => {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (typeof name !== "string" || name === "") return count;
    const free = typeof entry === "string" ? isFreeTool(name) : entry.free === true;
    if (free) return count;
    return normalizeToolName(name) === tool ? count + 1 : count;
  }, 0);
  const amount = roundAmount(share / Math.max(1, callsOfTool));
  const charged = applyCharge(ledger, ownerId, {
    toolCallId,
    tool,
    amount,
    groupKey,
  });
  if (!charged.ok) {
    if (charged.code !== "BUDGET_EXHAUSTED") return charged;
    // Turns are a ledger, not a fence. A branch that has spent its turns still
    // runs the call: the charge stops at zero, and the record keeps the tool's
    // name, so the REPL probe's `remaining` ends with `panhandled N` where the
    // caller reads it.
    const marked = notePanhandled(record, charged.tool, { callId: toolCallId });
    return {
      ok: true,
      amount: 0,
      panhandled: true,
      tool: charged.tool,
      count: marked.ok ? marked.count : 0,
      remaining: { ...record.remaining },
    };
  }
  return charged;
}

/**
 * A host compaction or handoff rewrote history. Advance the epoch so no elder
 * record from before the boundary can pair with anything after it.
 */
export function truncateForHostBoundary(state) {
  if (!state || typeof state !== "object") return false;
  const current =
    Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0;
  state.epoch = current + 1;
  return true;
}
