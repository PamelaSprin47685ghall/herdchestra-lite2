// Scope accounting: branch charging, amend refunds, and host boundaries.
// Every function mutates the state object it receives. No I/O.

import {
  failure,
  isNonEmptyString,
  put,
  isPlainObject,
  capCachePositions,
} from "./state.mjs";
import {
  beatShares,
  isFreeCall,
  normalizeToolName,
} from "./turns.mjs";
import { notePanhandled } from "./panhandle.mjs";
import { applyCharge, applyRefund, forkOf } from "./forkjoin.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

const E = loadDoc("errors");

// A charge entry exists to answer two questions: was this call already paid,
// and what did the beat an amend retires spend. Both concern a branch that is
// still running, so an entry of a closed branch is dead weight: no amend can
// name it, and the fork record's `remaining` already holds the truth. The map
// is only inspected once it passes `CHARGE_PRUNE_AT`, which keeps a long
// session flat without putting a cost on the ordinary turn.
const MAX_CHARGE_GROUPS = 16;
const MAX_UNGROUPED_CHARGES = 32;

/** True while the branch that owns an entry can still be amended. */
function amendable(ledger, ownerId) {
  if (!ledger || typeof ownerId !== "string") return false;
  const record = forkOf(ledger, ownerId);
  if (!record) return false;
  return record.status === "running" || record.status === "blocked";
}

/** Keep `state.charges` proportional to the work in flight, not to history. */
function boundStateCharges(state, ledger, ownerId) {
  const charges = state.charges;
  if (!isPlainObject(charges)) return;
  const keys = Object.keys(charges);
  // No branch can be over its cap while the whole map is this small, so the
  // ordinary turn pays a length check and nothing else.
  if (keys.length <= MAX_CHARGE_GROUPS) return;
  const groups = [];
  const members = new Map();
  const ungrouped = [];
  for (const key of keys) {
    const entry = charges[key];
    if (!isPlainObject(entry)) {
      delete charges[key];
      continue;
    }
    const owner = typeof entry.ownerId === "string" ? entry.ownerId : null;
    if (owner !== null && owner !== ownerId && !amendable(ledger, owner)) {
      delete charges[key];
      continue;
    }
    if (owner !== ownerId) continue;
    if (typeof entry.groupKey === "string") {
      if (!members.has(entry.groupKey)) {
        members.set(entry.groupKey, []);
        groups.push(entry.groupKey);
      }
      members.get(entry.groupKey).push(key);
    } else {
      ungrouped.push(key);
    }
  }
  const staleGroups = groups.slice(0, Math.max(0, groups.length - MAX_CHARGE_GROUPS));
  for (const group of staleGroups) {
    for (const key of members.get(group)) delete charges[key];
  }
  const staleCalls = ungrouped.slice(0, Math.max(0, ungrouped.length - MAX_UNGROUPED_CHARGES));
  for (const key of staleCalls) delete charges[key];
}

/**
 * Charge one tool call against the branch that owns it.
 *
 * A branch's budget exists only on its fork record. The root has no fork
 * record, so it has no budget: an ordinary tool is refused there and the work
 * must be delegated with `scope_fork`. A forked branch spends its own fork
 * record, never the parent's. Free calls (the control tools, `todo`, `ask`,
 * `wait`, and a `read` or `write` of a built-in protocol URI) pass at every
 * level. The per-call
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
    if (charged.code !== "BUDGET_EXHAUSTED") return charged;
    // Turns are a ledger, not a fence. A branch that has spent its
    // turns still runs the call: the charge stops at zero, and the record
    // keeps the tool's name, so `forkBudgetText` ends the budget line with
    // `panhandled Nx` where the caller reads it. The zero-amount charge entry
    // makes a retry of the same call free instead of a second admission.
    const marked = notePanhandled(record, charged.tool, { callId: toolCallId });
    if (typeof toolCallId === "string") {
      put(state.charges, toolCallId, {
        ownerId,
        tool: charged.tool,
        amount: 0,
        panhandled: true,
      });
      boundStateCharges(state, ledger, ownerId);
    }
    return {
      ok: true,
      amount: 0,
      panhandled: true,
      tool: charged.tool,
      count: marked.ok ? marked.count : 0,
      remaining: { ...record.remaining },
    };
  }
  if (charged.amount > 0 && typeof toolCallId === "string") {
    const entry = { ownerId, tool, amount: charged.amount };
    if (typeof groupKey === "string" && groupKey !== "") entry.groupKey = groupKey;
    put(state.charges, toolCallId, entry);
    boundStateCharges(state, ledger, ownerId);
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
  // The array is exposed to callers. Its contents can change without its
  // identity or length changing, so a length-keyed set is not authoritative.
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
