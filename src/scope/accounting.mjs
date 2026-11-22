// Scope accounting: branch charging, amend refunds, and host boundaries.
// Every function mutates the state object it receives. No I/O.

import {
  failure,
  isNonEmptyString,
  put,
  isPlainObject,
  capCachePositions,
} from "./state.mjs";
import { beatShares, isFreeCall, normalizeToolName } from "./budget.mjs";
import { applyCharge, applyRefund, forkOf } from "./forkjoin.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

const E = loadDoc("errors");

/**
 * Charge one tool call against the branch that owns it.
 *
 * A branch's tool budget exists only on its fork record. The root has no fork
 * record, so it has no budget: an ordinary tool is refused there and the work
 * must be delegated with `scope_fork`. A forked branch spends its own fork
 * record, never the parent's. Free calls (control tools, `todo`, `ask`, `wait`,
 * skill reads and staged-preview resolution) pass at every level. The per-call
 * detail stays in `state.charges` so an amend can refund exactly what one beat
 * spent, and repeating the same call or beat group changes nothing.
 */
export function chargeBranch(state, ledger, params = {}) {
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
  if (
    typeof toolCallId === "string" &&
    state.charges &&
    Object.hasOwn(state.charges, toolCallId)
  ) {
    return { ok: true, alreadyCharged: true, remaining: { ...record.remaining } };
  }
  const tool = normalizeToolName(toolName);
  const share =
    Array.isArray(beatTools) && beatTools.length > 0
      ? beatShares(beatTools)[tool] ?? 1
      : 1;
  const charged = applyCharge(ledger, ownerId, {
    toolCallId,
    tool,
    amount: share,
    groupKey,
  });
  if (!charged.ok) {
    if (charged.code === "BUDGET_EXHAUSTED") {
      return {
        ...charged,
        reason: render(E["tool-budget-exhausted"], {
          tool: charged.tool,
          remaining: charged.remaining,
          budget: charged.budget,
        }),
      };
    }
    return charged;
  }
  if (charged.amount > 0 && typeof toolCallId === "string") {
    const entry = { ownerId, tool, amount: charged.amount };
    if (typeof groupKey === "string" && groupKey !== "") entry.groupKey = groupKey;
    put(state.charges, toolCallId, entry);
  }
  return charged;
}

/** Give a branch back what one amended beat spent. Repeating it is a no-op. */
export function refundBranch(state, ledger, params = {}) {
  const { ownerId = null, toolCalls } = params;
  let refunded = 0;
  for (const call of toolCalls ?? []) {
    const charge = state.charges?.[call.id];
    if (!charge || (charge.ownerId ?? null) !== (ownerId ?? null)) continue;
    if (ownerId && ledger) {
      const undone = applyRefund(ledger, ownerId, call.id);
      if (undone.ok && undone.refunded > 0) refunded += 1;
    }
    delete state.charges[call.id];
  }
  return { ok: true, refunded };
}

/**
 * Retire one beat and refund the calls it spent on this branch. The refund is
 * the only accounting effect: an executed tool never runs backwards.
 */
export function applyAmend(state, ledger, params = {}) {
  const { ownerId = null, beat, toolCalls } = params;
  if (!beat || !isNonEmptyString(beat.key)) {
    return failure("INVALID_BEAT", "beat.key must be a non-empty string.");
  }
  if (!state.amends.includes(beat.key)) state.amends.push(beat.key);
  return refundBranch(state, ledger, { ownerId, toolCalls });
}

/**
 * A host compaction or handoff rewrote history. Advance the epoch so no elder
 * record from before the boundary can pair with anything after it, and drop
 * every provider cache estimate: the prefix the provider holds no longer
 * matches the branch.
 */
export function truncateForHostBoundary(state) {
  if (!state || typeof state !== "object") return false;
  const current =
    Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0;
  state.epoch = current + 1;
  capCachePositions(state, 0);
  // Charges name tool frames that the host may have removed with the
  // boundary. Keeping them would let an amend appear to refund a call the
  // branch can no longer show; the branch's spent total stays authoritative.
  if (isPlainObject(state.charges)) {
    for (const key of Object.keys(state.charges)) delete state.charges[key];
  }
  return true;
}
