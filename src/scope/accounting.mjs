// Scope accounting: open, close, charge, amend, and host boundaries.
// Every function mutates the state object it receives. No I/O.

import {
  failure,
  isNonEmptyString,
  put,
  copyCounts,
  isPlainObject,
  currentScope,
  makeScope,
  capCachePositions,
} from "./state.mjs";
import {
  beatShares,
  formatAmount,
  isFreeCall,
  normalizeBudget,
  normalizeToolName,
  roundAmount,
  validBudget,
} from "./budget.mjs";
import { DECISION_FRAMING, NORMAL_STAGES, WORKFLOW_STAGES } from "./stages.mjs";
import { EXECUTION_STAGE, missingStages } from "./stage-flags.mjs";

/** Validate the whole batch without changing state. */
export function validateFission(state, begin, options = {}) {
  if (!Array.isArray(begin?.fission) || begin.fission.length === 0) {
    return failure("INVALID_FISSION", "fission must be a non-empty array.");
  }
  if (!Object.hasOwn(begin, "elder_report") ||
      (begin.elder_report !== null && typeof begin.elder_report !== "string")) {
    return failure("INVALID_ARGUMENT", "elder_report must be a string or null.");
  }
  if (typeof begin.time !== "number" || !Number.isFinite(begin.time) || begin.time <= 0) {
    return failure(
      "INVALID_TIME",
      "time is required and must be a positive number of seconds.",
    );
  }
  const items = [];
  const totals = {};
  for (const item of begin.fission) {
    if (!isPlainObject(item) || !isNonEmptyString(item.intent) ||
        !Object.hasOwn(item, "budget") || !Object.hasOwn(item, "permission")) {
      return failure("INVALID_FISSION_ITEM", "Each flow requires intent, budget, and permission.");
    }
    if (!validBudget(item.budget)) {
      return failure("INVALID_BUDGET", "Budget must be a plain object of non-negative integer tool budgets.");
    }
    const budget = normalizeBudget(item.budget);
    if (!validBudget(budget)) {
      return failure("INVALID_BUDGET", "Normalized budget is invalid.");
    }
    if (item.permission !== "ro" && item.permission !== "rw") {
      return failure("INVALID_ARGUMENT", "permission must be ro or rw.");
    }
    if (item.model !== undefined && item.model !== null && !isNonEmptyString(item.model)) {
      return failure("INVALID_ARGUMENT", "model must be a non-empty string or null.");
    }
    if (item.permission === "rw" && begin.stage === DECISION_FRAMING) {
      return failure("RW_IN_DECISION_FRAMING", "Write permission is unavailable in decision-framing.");
    }
    if (
      item.permission === "rw" &&
      options.relayOn &&
      state.relay?.fullFlow === true &&
      state.relay?.firstEvaluation === null
    ) {
      return failure("RW_BEFORE_LEDGER", "Write permission requires the first ledger evaluation.");
    }
    for (const tool of Object.keys(budget)) {
      const total = (Object.hasOwn(totals, tool) ? totals[tool] : 0) + budget[tool];
      if (!Number.isSafeInteger(total)) return failure("INVALID_BUDGET", "Combined budget is too large.");
      put(totals, tool, total);
    }
    items.push({ ...item, intent: item.intent.trim(), budget });
  }
  if (!WORKFLOW_STAGES.includes(begin.stage) ||
      (state.herdMode ? begin.stage !== DECISION_FRAMING : !NORMAL_STAGES.includes(begin.stage))) {
    return failure("INVALID_STAGE", "The stage is not available in this mode.");
  }
  if (
    options.mainAgent &&
    options.stagesOff !== true &&
    state.relay?.fullFlow === true &&
    begin.stage === EXECUTION_STAGE &&
    missingStages(state.stageFlags).length > 0
  ) {
    return failure("STAGE_FLAGS_UNMET", "Required workflow stages have not been opened.");
  }
  const parent = currentScope(state);
  if (parent) {
    for (const tool of Object.keys(totals)) {
      const remaining = Object.hasOwn(parent.remaining, tool) ? parent.remaining[tool] : 0;
      if (!Number.isFinite(remaining) || totals[tool] > remaining) {
        return failure("INVALID_BUDGET", `Insufficient parent budget for ${tool}.`);
      }
    }
  }
  return { ok: true, items, totals };
}

/** Reserve all child budgets together; unused reservations never return. */
export function splitFissionBudget(state, begin, options = {}) {
  const result = validateFission(state, begin, options);
  if (!result.ok) return result;
  const parent = currentScope(state);
  if (parent) {
    for (const tool of Object.keys(result.totals)) {
      const amount = result.totals[tool];
      if (amount === 0) continue;
      put(parent.remaining, tool, roundAmount(parent.remaining[tool] - amount));
      const spent = Object.hasOwn(parent.spent, tool) ? parent.spent[tool] : 0;
      put(parent.spent, tool, roundAmount(spent + amount));
    }
  }
  return result;
}

export function beginScope(state, params) {
  const { toolCallId, intent, stage, budget, time } = params || {};
  if (!isNonEmptyString(intent)) {
    return failure("INVALID_INTENT", "intent must be a non-empty string.");
  }
  if (!WORKFLOW_STAGES.includes(stage)) {
    return failure("INVALID_STAGE", `stage must be one of: ${WORKFLOW_STAGES.join(" | ")}.`);
  }
  const normalized = normalizeBudget(budget);
  if (!validBudget(normalized)) {
    return failure(
      "INVALID_BUDGET",
      "Budget must be a plain object of non-negative integer tool budgets.",
    );
  }
  if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) {
    return failure(
      "INVALID_TIME",
      "time is required and must be a positive number of seconds.",
    );
  }
  const timeBudgetMs = Math.round(time * 1000);
  const scope = makeScope(state, toolCallId, intent, stage, normalized, timeBudgetMs);
  // Optional model identity: { modelSpec, modelKey, previousModelSpec,
  // previousModelKey, baseModelKey }. Strings or null only.
  const model = isPlainObject(params?.model) ? params.model : null;
  if (model) {
    for (const key of [
      "modelSpec",
      "modelKey",
      "previousModelSpec",
      "previousModelKey",
      "baseModelKey",
    ]) {
      const value = model[key];
      if (typeof value === "string" || value === null) put(scope, key, value);
    }
  }
  state.scopes.push(scope);
  return { ok: true, scope };
}

export function closeScope(state, params) {
  const { toolCallId } = params || {};
  const scope = currentScope(state);
  if (!scope) {
    return failure("NOT_IN_SCOPE", "No active scope to close.");
  }
  state.scopes.pop();
  for (const key of Object.keys(state.charges)) {
    if (state.charges[key]?.scopeId === scope.id) delete state.charges[key];
  }
  return { ok: true, scope };
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
  const { toolCallId, toolName, groupKey, beatTools, input } = params || {};
  const normalized = normalizeToolName(toolName);
  const scope = currentScope(state);
  if (!scope) {
    return failure(
      "NOT_IN_SCOPE",
      "Outside all scopes, only todo and the free control tools (scope, amend, pin) may be called. Open a scope with scope({ begin: { stage, elder_report, time, fission: [{ intent, budget, permission }] } }).",
    );
  }
  if (isFreeCall(toolName, input)) {
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
  const spent = Object.hasOwn(scope.spent, normalized) ? scope.spent[normalized] : 0;
  const remaining = Object.hasOwn(scope.remaining, normalized) ? scope.remaining[normalized] : undefined;
  const budget = Object.hasOwn(scope.budget, normalized) ? scope.budget[normalized] : 0;
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

export function applyAmend(state, params) {
  const { scopeId, beat, toolCalls } = params || {};
  const scope = currentScope(state);
  if (!scope) {
    return failure("NOT_IN_SCOPE", "Amend requires an active scope.");
  }
  if (scope.id !== scopeId) {
    return failure("SCOPE_MISMATCH", "The amend target does not match the current scope.");
  }
  if (!beat || !isNonEmptyString(beat.key)) {
    return failure("INVALID_BEAT", "beat.key must be a non-empty string.");
  }
  state.amends.push(beat.key);
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
  }
  return {
    ok: true,
    refunded,
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

function matchesLevel(record, parentId, boundary, epoch) {
  return (
    record &&
    (record.parentId ?? null) === (parentId ?? null) &&
    (record.boundary ?? 0) === boundary &&
    (record.epoch ?? 0) === epoch
  );
}

/**
 * When a scope closes, its innermost still-unarchived child will never get a
 * later sibling. Seal it so the model is never asked for a lost elder report.
 */
export function sealClosedParentChildren(state, parentScopeId) {
  let sealed = 0;
  for (const record of state?.collapses ?? []) {
    if (!matchesLevel(record, parentScopeId, record.boundary ?? 0, record.epoch ?? 0)) {
      continue;
    }
    if (record.collapsed !== false || record.sealed === true) continue;
    if (record.report !== null) continue;
    record.sealed = true;
    sealed += 1;
  }
  return sealed;
}

/** The single unarchived elder at a level, if one is pending a report. */
export function findPendingReportElder(state, parentId, boundary = 0, epoch = 0) {
  for (const record of state?.collapses ?? []) {
    if (!matchesLevel(record, parentId, boundary, epoch)) continue;
    if (record.collapsed !== false || record.sealed === true) continue;
    if (record.report !== null) continue;
    return record;
  }
  return null;
}

/** The highest-order uncollapsed record at a level: hot workbench or pending elder. */
export function findHotWorkbench(state, parentId, boundary = 0, epoch = 0) {
  let hot = null;
  for (const record of state?.collapses ?? []) {
    if (!matchesLevel(record, parentId, boundary, epoch)) continue;
    if (record.collapsed !== false) continue;
    if (!Number.isInteger(record.order)) continue;
    if (!hot || record.order > hot.order) hot = record;
  }
  return hot;
}

/** Archived, unsealed elders strictly behind the hot workbench, in order. */
export function findFoldablePool(state, parentId, boundary = 0, epoch = 0) {
  const hot = findHotWorkbench(state, parentId, boundary, epoch);
  const hotOrder = hot ? hot.order : Number.POSITIVE_INFINITY;
  const pool = [];
  for (const record of state?.collapses ?? []) {
    if (!matchesLevel(record, parentId, boundary, epoch)) continue;
    if (record.collapsed !== false || record.sealed === true) continue;
    if (!isNonEmptyString(record.report)) continue;
    if (!Number.isInteger(record.order) || record.order >= hotOrder) continue;
    pool.push(record);
  }
  pool.sort((a, b) => a.order - b.order);
  return pool;
}

/**
 * Foldable pools at levels that are still live: the root level or a parent
 * scope that remains on the stack, in the current epoch.
 */
export function findActivePools(state) {
  const activeParentIds = new Set([
    null,
    ...(state?.scopes ?? []).map((scope) => scope.id),
  ]);
  const epoch = Number.isInteger(state?.epoch) ? state.epoch : 0;
  const levels = new Map();
  for (const record of state?.collapses ?? []) {
    if (!record || record.collapsed !== false || record.sealed === true) continue;
    if (!isNonEmptyString(record.report)) continue;
    if (!activeParentIds.has(record.parentId ?? null)) continue;
    if ((record.epoch ?? 0) !== epoch) continue;
    const parentId = record.parentId ?? null;
    const boundary = record.boundary ?? 0;
    const key = JSON.stringify([parentId, boundary, epoch]);
    if (!levels.has(key)) levels.set(key, { parentId, boundary, epoch });
  }
  const groups = [];
  for (const level of levels.values()) {
    const pool = findFoldablePool(state, level.parentId, level.boundary, level.epoch);
    if (pool.length > 0) groups.push({ ...level, pool });
  }
  return groups;
}

/** When an elder folds, its collapsed descendants become subsumed transitively. */
export function markSubsumedDescendants(state, foldedRecords) {
  const foldedIds = new Set();
  for (const record of foldedRecords ?? []) {
    if (isNonEmptyString(record?.scopeId)) foldedIds.add(record.scopeId);
  }
  let marked = 0;
  let grew = true;
  while (grew) {
    grew = false;
    for (const record of state?.collapses ?? []) {
      if (!record || record.collapsed === true) continue;
      if (!isNonEmptyString(record.scopeId)) continue;
      if (!foldedIds.has(record.parentId ?? null)) continue;
      record.collapsed = true;
      foldedIds.add(record.scopeId);
      marked += 1;
      grew = true;
    }
  }
  return marked;
}

/**
 * A host compaction or handoff truncates history. Keep only the outermost
 * scope, clear charges owned by dropped inner scopes, and advance the epoch so
 * later scopes (and the surviving outer scope) never match pre-truncation
 * elder siblings. Deferred findings from dropped scopes move to the outermost
 * scope instead of disappearing. Herd mode and pins belong to the session and
 * survive the boundary.
 */
export function truncateForHostBoundary(state) {
  if (!state || typeof state !== "object") return false;
  const current =
    Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0;
  const nextEpoch = current + 1;
  // Retire every record from the old epoch: an unarchived elder is sealed,
  // anything else still visible is collapsed. Old accounts never leak forward.
  for (const record of state.collapses ?? []) {
    if (!record || (record.epoch ?? 0) !== current) continue;
    if (record.collapsed !== false) continue;
    if (record.report === null && record.sealed !== true) {
      record.sealed = true;
    } else if (record.sealed !== true) {
      record.collapsed = true;
    }
  }
  state.epoch = nextEpoch;
  // A host boundary physically rewrote history: every provider cache prefix
  // is invalidated conservatively, even when no scope survives.
  capCachePositions(state, 0);
  if (!Array.isArray(state.scopes) || state.scopes.length === 0) return true;
  const kept = state.scopes[0];
  const dropped = state.scopes.slice(1);
  state.scopes = [kept];
  kept.epoch = nextEpoch;
  kept.baseInputTokens = null;
  // When inner scopes were dropped, record the recovery target for the
  // pending model switch. The base model lives outside all scopes and is
  // never rewritten here; the target is the surviving outer scope's model,
  // falling back to the persisted base model.
  if (dropped.length > 0) {
    const targetSpec =
      typeof kept.modelSpec === "string" ? kept.modelSpec : state.baseModelSpec;
    const expectedKey =
      typeof kept.modelKey === "string" ? kept.modelKey : state.baseModelKey;
    state.modelRecovery =
      targetSpec != null || expectedKey != null
        ? { targetSpec: targetSpec ?? null, expectedKey: expectedKey ?? null }
        : null;
  }
  const charges = state.charges;
  if (charges && typeof charges === "object") {
    for (const key of Object.keys(charges)) {
      if (charges[key]?.scopeId !== kept.id) delete charges[key];
    }
  }
  return true;
}
