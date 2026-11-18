import { copyRelay, createRelay, isValidRelay } from "./relay.mjs";

// Herdchestra Lite 2.0 engine. Pure scope accounting. No I/O.
//
// Callers pass plain objects in and receive plain objects out. Every exported
// function mutates the state object that it receives, except the serializers.
// Control tools are free and are never budgeted.

const VERSION = 2;

const CONTROL_TOOLS = new Set(["scope", "regret", "defer", "pin"]);

// Charge amounts are real numbers with at most two decimal places. One budget
// unit is split into 100 hundredths so an assistant turn spends exactly one
// unit however its tools divide it.
const CHARGE_SCALE = 100;

const STEER_HEADER =
  "You deferred the following findings in this scope. Address them now:";

function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function failure(code, reason) {
  return { ok: false, code, reason };
}

// Define an own data property. This is safe for keys such as "__proto__".
function put(object, key, value) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function copyCounts(source) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") continue;
    put(out, key, source[key]);
  }
  return out;
}

function copyCharges(source) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") continue;
    const charge = source[key];
    if (!isPlainObject(charge)) continue;
    const copied = {
      scopeId: charge.scopeId,
      tool: charge.tool,
      amount: charge.amount,
    };
    if (typeof charge.groupKey === "string") copied.groupKey = charge.groupKey;
    put(out, key, copied);
  }
  return out;
}

function copyDefers(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({
    toolCallId: item.toolCallId,
    intent: item.intent,
  }));
}

function copyCollapse(collapse) {
	return {
    beginToolCallId: collapse.beginToolCallId,
    endToolCallId: collapse.endToolCallId,
    report: collapse.report,
    parentId:
      typeof collapse.parentId === "string" && collapse.parentId !== ""
        ? collapse.parentId
        : null,
    order:
      Number.isInteger(collapse.order) && collapse.order >= 0
        ? collapse.order
        : 0,
    collapsed: collapse.collapsed !== false,
    createdAt: collapse.createdAt,
    boundary:
      Number.isInteger(collapse.boundary) && collapse.boundary >= 0
        ? collapse.boundary
        : 0,
    epoch:
      Number.isInteger(collapse.epoch) && collapse.epoch >= 0
        ? collapse.epoch
        : 0,
  };
}

function validBudget(budget) {
  if (!isPlainObject(budget)) return false;
  for (const tool of Reflect.ownKeys(budget)) {
    if (typeof tool !== "string" || !isNonEmptyString(tool)) return false;
    const amount = budget[tool];
    if (!Number.isInteger(amount) || amount < 0) return false;
  }
  return true;
}

/** Normalize tool names: apply_patch → edit. */
function normalizeBudget(budget) {
  if (!isPlainObject(budget)) return budget;
  const normalized = {};
  for (const key of Reflect.ownKeys(budget)) {
    if (typeof key !== "string") continue;
    const normalizedKey = key === "apply_patch" ? "edit" : key;
    const currentValue = normalized[normalizedKey] ?? 0;
    put(normalized, normalizedKey, currentValue + budget[key]);
  }
  return normalized;
}

/** Normalize a single tool name: apply_patch → edit. */
function normalizeToolName(toolName) {
  return toolName === "apply_patch" ? "edit" : toolName;
}

/** Round a charge amount to the two-decimal budget precision. */
export function roundAmount(value) {
  return Math.round(value * CHARGE_SCALE) / CHARGE_SCALE;
}

/** Render an amount with the fixed two-decimal display precision. */
export function formatAmount(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

/**
 * Split one budget unit across the tools called in a single assistant
 * message, in proportion to their call counts. The shares sum to exactly one
 * unit. Control tools and `todo` spend nothing and take no share.
 */
export function beatShares(toolNames) {
  const counts = new Map();
  let total = 0;
  for (const name of Array.isArray(toolNames) ? toolNames : []) {
    if (typeof name !== "string" || name === "") continue;
    if (CONTROL_TOOLS.has(name) || name === "todo") continue;
    const tool = normalizeToolName(name);
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return {};
  const shares = {};
  let assigned = 0;
  let largestTool = null;
  let largestCount = 0;
  for (const [tool, count] of counts) {
    const part = Math.max(1, Math.round((count * CHARGE_SCALE) / total));
    put(shares, tool, part);
    assigned += part;
    if (count > largestCount) {
      largestCount = count;
      largestTool = tool;
    }
  }
  // Hand the rounding residue to the most frequent tool so the shares always
  // add up to one unit.
  const correction = CHARGE_SCALE - assigned;
  if (correction !== 0) {
    put(shares, largestTool, Math.max(0, shares[largestTool] + correction));
  }
  for (const tool of Object.keys(shares)) {
    put(shares, tool, roundAmount(shares[tool] / CHARGE_SCALE));
  }
  return shares;
}

function makeScope(state, toolCallId, intent, budget) {
  const spent = {};
  for (const tool of Reflect.ownKeys(budget)) {
    if (typeof tool === "string") put(spent, tool, 0);
  }
  return {
    id: `scope-${++state.seq}`,
    boundary:
      Number.isInteger(state.relay?.generation) && state.relay.generation >= 0
        ? state.relay.generation
        : 0,
    epoch:
      Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0,
    intent: intent.trim(),
    beginToolCallId: typeof toolCallId === "string" ? toolCallId : "",
    budget: copyCounts(budget),
    remaining: copyCounts(budget),
    spent,
    defers: [],
    residualDefers: [],
  };
}

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

export function createState() {
  return {
    version: VERSION,
    seq: 0,
    epoch: 0,
    scopes: [],
    charges: {},
    regrets: [],
    collapses: [],
    relay: createRelay(),
  };
}

export function currentScope(state) {
  if (!state || !Array.isArray(state.scopes) || state.scopes.length === 0) {
    return null;
  }
  return state.scopes[state.scopes.length - 1];
}

/** Return a scope's creation order, derived from its generated id. */
export function scopeOrder(scope) {
  const match = /^scope-(\d+)$/.exec(String(scope?.id ?? ""));
  return match ? Number(match[1]) : 0;
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

export function budgetText(scope) {
  if (!scope || !isPlainObject(scope.remaining)) return "";
  const entries = [];
  for (const tool of Reflect.ownKeys(scope.remaining).sort()) {
    if (typeof tool !== "string") continue;
    const remaining = scope.remaining[tool];
    const budget = scope.budget[tool];
    if (budget === undefined) continue;
    entries.push(
      `${tool} ${formatAmount(remaining)}/${formatAmount(budget)}`,
    );
  }
  return entries.join(", ");
}

export function serializeState(state) {
  return {
    version: VERSION,
    seq: state.seq ?? 0,
    scopes: (state.scopes ?? []).map((scope) => ({
      id: scope.id,
      boundary:
        Number.isInteger(scope.boundary) && scope.boundary >= 0
          ? scope.boundary
          : 0,
      epoch:
        Number.isInteger(scope.epoch) && scope.epoch >= 0 ? scope.epoch : 0,
      intent: scope.intent,
      beginToolCallId: scope.beginToolCallId,
      budget: copyCounts(scope.budget),
      remaining: copyCounts(scope.remaining),
      spent: copyCounts(scope.spent),
      defers: copyDefers(scope.defers),
      residualDefers: copyDefers(scope.residualDefers),
    })),
    charges: copyCharges(state.charges),
    regrets: Array.isArray(state.regrets) ? state.regrets.slice() : [],
    collapses: Array.isArray(state.collapses)
      ? state.collapses.map(copyCollapse)
      : [],
    epoch:
      Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0,
    relay: copyRelay(state.relay),
  };
}

function validDefers(value) {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item)) return false;
    if (typeof item.toolCallId !== "string") return false;
    if (!isNonEmptyString(item.intent)) return false;
  }
  return true;
}

function validBudgetCounts(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const amount = value[key];
    if (!Number.isInteger(amount) || amount < 0) return false;
  }
  return true;
}

function validAmountCounts(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const amount = value[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return false;
    }
  }
  return true;
}

function validScope(scope) {
  if (!isPlainObject(scope)) return false;
  if (!isNonEmptyString(scope.id)) return false;
  if (!isNonEmptyString(scope.intent)) return false;
  if (
    scope.boundary !== undefined &&
    (!Number.isInteger(scope.boundary) || scope.boundary < 0)
  ) {
    return false;
  }
  if (
    scope.epoch !== undefined &&
    (!Number.isInteger(scope.epoch) || scope.epoch < 0)
  ) {
    return false;
  }
  if (typeof scope.beginToolCallId !== "string") return false;
  if (!validBudgetCounts(scope.budget)) return false;
  if (!validAmountCounts(scope.remaining)) return false;
  if (!validAmountCounts(scope.spent)) return false;
  if (!validDefers(scope.defers)) return false;
  if (!validDefers(scope.residualDefers)) return false;
  return true;
}

function validCharges(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const charge = value[key];
    if (!isPlainObject(charge)) return false;
    if (!isNonEmptyString(charge.scopeId)) return false;
    if (!isNonEmptyString(charge.tool)) return false;
    if (
      typeof charge.amount !== "number" ||
      !Number.isFinite(charge.amount) ||
      charge.amount <= 0
    ) {
      return false;
    }
    if (charge.groupKey !== undefined && typeof charge.groupKey !== "string") {
      return false;
    }
  }
  return true;
}

function validCollapses(value) {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item)) return false;
    if (!isNonEmptyString(item.beginToolCallId)) return false;
    if (!isNonEmptyString(item.endToolCallId)) return false;
    if (!isNonEmptyString(item.report)) return false;
    if (typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)) {
      return false;
    }
    if (
      item.boundary !== undefined &&
      (!Number.isInteger(item.boundary) || item.boundary < 0)
    ) {
      return false;
    }
    if (
      item.epoch !== undefined &&
      (!Number.isInteger(item.epoch) || item.epoch < 0)
    ) {
      return false;
    }
    if (
      item.parentId !== undefined &&
      item.parentId !== null &&
      !isNonEmptyString(item.parentId)
    ) {
      return false;
    }
    if (
      item.order !== undefined &&
      (!Number.isInteger(item.order) || item.order < 0)
    ) {
      return false;
    }
    if (item.collapsed !== undefined && typeof item.collapsed !== "boolean") {
      return false;
    }
  }
  return true;
}

export function deserializeState(input) {
  try {
    let data = input;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return createState();
      }
    }
    if (
      !isPlainObject(data) ||
      (data.version !== 1 && data.version !== VERSION)
    ) {
      return createState();
    }
    // Version 1 predates the relay state. Its other fields keep their meaning,
    // so migrate them instead of discarding the scope history.
    if (data.version === VERSION && !isValidRelay(data.relay)) {
      return createState();
    }
    if (!Number.isInteger(data.seq) || data.seq < 0) return createState();
    if (!Array.isArray(data.scopes) || !data.scopes.every(validScope)) {
      return createState();
    }
    if (!validCharges(data.charges)) return createState();
    if (
      !Array.isArray(data.regrets) ||
      !data.regrets.every((key) => typeof key === "string")
    ) {
      return createState();
    }
    if (!validCollapses(data.collapses)) return createState();
    if (
      data.epoch !== undefined &&
      (!Number.isInteger(data.epoch) || data.epoch < 0)
    ) {
      return createState();
    }
    return {
      version: VERSION,
      seq: data.seq,
      epoch:
        Number.isInteger(data.epoch) && data.epoch >= 0 ? data.epoch : 0,
      scopes: data.scopes.map((scope) => ({
        id: scope.id,
        boundary:
          Number.isInteger(scope.boundary) && scope.boundary >= 0
            ? scope.boundary
            : 0,
        epoch:
          Number.isInteger(scope.epoch) && scope.epoch >= 0 ? scope.epoch : 0,
        intent: scope.intent,
        beginToolCallId: scope.beginToolCallId,
        budget: copyCounts(scope.budget),
        remaining: copyCounts(scope.remaining),
        spent: copyCounts(scope.spent),
        defers: copyDefers(scope.defers),
        residualDefers: copyDefers(scope.residualDefers),
      })),
      charges: copyCharges(data.charges),
      regrets: data.regrets.slice(),
      collapses: data.collapses.map(copyCollapse),
      relay: data.version === VERSION ? copyRelay(data.relay) : createRelay(),
    };
  } catch {
    return createState();
  }
}
