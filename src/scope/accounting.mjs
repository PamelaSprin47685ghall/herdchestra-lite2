// Scope accounting: open, close, charge, defer, regret, and host boundaries.
// Every function mutates the state object it receives. No I/O.

import {
  CONTROL_TOOLS,
  failure,
  isNonEmptyString,
  put,
  copyCounts,
  currentScope,
  makeScope,
} from "./state.mjs";
import {
  beatShares,
  formatAmount,
  normalizeBudget,
  normalizeToolName,
  roundAmount,
  validBudget,
} from "./budget.mjs";

const STEER_HEADER =
  "You deferred the following findings in this scope. Address them now:";

function collectDefers(scope) {
  const seen = new Set();
  const out = [];
  for (const item of [...scope.defers, ...scope.residualDefers]) {
    const intent = item.intent.trim();
    if (seen.has(intent)) continue;
    seen.add(intent);
    out.push({ toolCallId: item.toolCallId, intent });
  }
  return out;
}

function steerText(defers) {
  if (defers.length === 0) return "";
  const lines = defers.map((item) => `- ${item.intent}`);
  return [STEER_HEADER, ...lines].join("\n");
}

function withdrawDefer(scope, toolCallId) {
  const index = scope.defers.findIndex((item) => item.toolCallId === toolCallId);
  if (index === -1) return;
  const [item] = scope.defers.splice(index, 1);
  if (scope.residualDefers.some((entry) => entry.toolCallId === toolCallId)) return;
  scope.residualDefers.push({
    toolCallId: item.toolCallId,
    intent: item.intent,
  });
}

export function beginScope(state, params) {
  const { toolCallId, intent, budget } = params || {};
  if (!isNonEmptyString(intent)) {
    return failure("INVALID_INTENT", "intent must be a non-empty string.");
  }
  const normalized = normalizeBudget(budget);
  if (!validBudget(normalized)) {
    return failure(
      "INVALID_BUDGET",
      "Budget must be a plain object of non-negative integer tool budgets.",
    );
  }
  const scope = makeScope(state, toolCallId, intent, normalized);
  state.scopes.push(scope);
  return { ok: true, scope };
}

export function closeScope(state, params) {
  const { toolCallId, report } = params || {};
  const scope = currentScope(state);
  if (!scope) {
    return failure("NOT_IN_SCOPE", "No active scope to close.");
  }
  if (!isNonEmptyString(report)) {
    return failure("INVALID_REPORT", "report must be a non-empty string.");
  }
  state.scopes.pop();
  for (const key of Object.keys(state.charges)) {
    if (state.charges[key]?.scopeId === scope.id) delete state.charges[key];
  }
  const defers = collectDefers(scope);
  return { ok: true, scope, defers, steerText: steerText(defers) };
}

function groupAlreadyCharged(state, scopeId, tool, groupKey) {
  if (typeof groupKey !== "string" || groupKey === "") return false;
  for (const key of Object.keys(state.charges)) {
    const charge = state.charges[key];
    if (
      charge?.scopeId === scopeId &&
      charge.tool === tool &&
      charge.groupKey === groupKey
    ) {
      return true;
    }
  }
  return false;
}

export function chargeTool(state, params) {
  const { toolCallId, toolName, groupKey, beatTools } = params || {};
  const normalized = normalizeToolName(toolName);
  const scope = currentScope(state);
  if (!scope) {
    return failure("NOT_IN_SCOPE", "Not in a scope. Call scope with begin first.");
  }
  if (CONTROL_TOOLS.has(toolName)) {
    return { ok: true, remaining: copyCounts(scope.remaining) };
  }
  if (
    typeof toolCallId === "string" &&
    Object.prototype.hasOwnProperty.call(state.charges, toolCallId)
  ) {
    return { ok: true, remaining: copyCounts(scope.remaining) };
  }
  if (groupAlreadyCharged(state, scope.id, normalized, groupKey)) {
    return { ok: true, remaining: copyCounts(scope.remaining) };
  }
  const spent = scope.spent[normalized] ?? 0;
  const remaining = scope.remaining[normalized];
  const budget = scope.budget[normalized] ?? 0;
  if (remaining === undefined || remaining <= 0) {
    return failure(
      "BUDGET_EXHAUSTED",
      `Tool "${normalized}" has no budget left (${formatAmount(remaining ?? 0)}/${formatAmount(budget)}). No more calls allowed.`,
    );
  }
  // A shared unit is split by call count across the tools of the beat. A tool
  // whose remaining balance is smaller than its share pays what it has; the
  // other tools of the same message still run, so a short balance produces a
  // partial success instead of blocking the whole turn.
  const share =
    Array.isArray(beatTools) && beatTools.length > 0
      ? beatShares(beatTools)[normalized] ?? 1
      : 1;
  const requested = Number.isFinite(share) && share >= 0 ? share : 1;
  const amount = roundAmount(Math.min(requested, remaining));
  put(scope.spent, normalized, roundAmount(spent + amount));
  put(scope.remaining, normalized, roundAmount(remaining - amount));
  if (amount > 0) {
    const charge = {
      scopeId: scope.id,
      tool: normalized,
      amount,
    };
    if (typeof groupKey === "string" && groupKey !== "") {
      charge.groupKey = groupKey;
    }
    put(state.charges, toolCallId, charge);
  }
  return { ok: true, remaining: copyCounts(scope.remaining) };
}

export function deferIntent(state, params) {
  const { toolCallId, intent } = params || {};
  const scope = currentScope(state);
  if (!scope) {
    return failure("NOT_IN_SCOPE", "defer is only allowed inside a scope.");
  }
  if (!isNonEmptyString(intent)) {
    return failure("INVALID_INTENT", "intent must be a non-empty string.");
  }
  scope.defers.push({
    toolCallId: typeof toolCallId === "string" ? toolCallId : "",
    intent: intent.trim(),
  });
  return { ok: true };
}

export function applyRegret(state, params) {
  const { scopeId, beat, toolCalls } = params || {};
  const scope = currentScope(state);
  if (!scope) {
    return failure("NOT_IN_SCOPE", "Regret requires an active scope.");
  }
  if (scope.id !== scopeId) {
    return failure("SCOPE_MISMATCH", "The regret target does not match the current scope.");
  }
  if (!beat || !isNonEmptyString(beat.key)) {
    return failure("INVALID_BEAT", "beat.key must be a non-empty string.");
  }
  state.regrets.push(beat.key);
  let refunded = 0;
  for (const call of toolCalls ?? []) {
    const charge = state.charges[call.id];
    if (charge && charge.scopeId === scopeId) {
      const normalized = normalizeToolName(charge.tool);
      const spent = scope.spent[normalized] ?? 0;
      const remaining = scope.remaining[normalized] ?? 0;
      const amount =
        Number.isFinite(charge.amount) && charge.amount > 0 ? charge.amount : 1;
      if (spent > 0) {
        const refund = Math.min(amount, spent);
        put(scope.spent, normalized, roundAmount(Math.max(0, spent - refund)));
        put(scope.remaining, normalized, roundAmount(remaining + refund));
        refunded += 1;
      }
      delete state.charges[call.id];
    }
    withdrawDefer(scope, call.id);
  }
  return {
    ok: true,
    refunded,
    residualDefers: scope.residualDefers.slice(),
    remaining: copyCounts(scope.remaining),
  };
}

/**
 * Find the immediately elder sibling of a scope: same parent, smaller order,
 * still visible (not yet collapsed). Siblings close in order, so this is the
 * scope that should be collapsed when the current scope closes.
 */
export function findElderSibling(state, parentId, order, boundary = 0, epoch = 0) {
  let best = null;
  for (const record of state?.collapses ?? []) {
    if (!record || record.collapsed !== false) continue;
    if ((record.parentId ?? null) !== (parentId ?? null)) continue;
    if ((record.boundary ?? 0) !== boundary) continue;
    if ((record.epoch ?? 0) !== epoch) continue;
    if (!Number.isInteger(record.order) || record.order >= order) continue;
    if (!best || record.order > best.order) best = record;
  }
  return best;
}

/**
 * A host compaction or handoff truncates history. Keep only the outermost
 * scope, clear charges owned by dropped inner scopes, and advance the epoch so
 * later scopes (and the surviving outer scope) never match pre-truncation
 * elder siblings. Deferred findings from dropped scopes move to the outermost
 * scope instead of disappearing.
 */
export function truncateForHostBoundary(state) {
  if (!state || typeof state !== "object") return false;
  const current =
    Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0;
  state.epoch = current + 1;
  if (!Array.isArray(state.scopes) || state.scopes.length === 0) return true;
  const kept = state.scopes[0];
  const dropped = state.scopes.slice(1);
  state.scopes = [kept];
  kept.epoch = state.epoch;
  const charges = state.charges;
  if (charges && typeof charges === "object") {
    for (const key of Object.keys(charges)) {
      if (charges[key]?.scopeId !== kept.id) delete charges[key];
    }
  }
  if (dropped.length > 0) {
    const seen = new Set(
      (kept.defers ?? []).map((item) => item.toolCallId),
    );
    for (const scope of dropped) {
      for (const item of [...(scope.defers ?? []), ...(scope.residualDefers ?? [])]) {
        if (seen.has(item.toolCallId)) continue;
        seen.add(item.toolCallId);
        kept.defers.push({
          toolCallId: item.toolCallId,
          intent: item.intent,
        });
      }
    }
  }
  return true;
}
