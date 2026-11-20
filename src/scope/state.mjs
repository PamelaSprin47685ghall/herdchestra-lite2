// Scope state: creation, inspection, and the base copy helpers.
// Pure data. No I/O.

import { createRelay } from "../relay/state.mjs";
import { createStageFlags } from "./stage-flags.mjs";

const VERSION = 2;

const CONTROL_TOOLS = new Set(["scope", "amend", "defer", "pin"]);

/** Provider prompt-cache entries live for five minutes. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

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

function copyDefers(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({
    toolCallId: item.toolCallId,
    intent: item.intent,
  }));
}

function makeScope(state, toolCallId, intent, stage, budget, timeBudgetMs = null) {
  const spent = {};
  for (const tool of Reflect.ownKeys(budget)) {
    if (typeof tool === "string") put(spent, tool, 0);
  }
  const openedAt = Date.now();
  return {
    timeBudgetMs:
      Number.isFinite(timeBudgetMs) && timeBudgetMs > 0 ? timeBudgetMs : null,
    openedAt,
    deadlineAt:
      Number.isFinite(timeBudgetMs) && timeBudgetMs > 0
        ? openedAt + timeBudgetMs
        : null,
    overtimeAt: null,
    id: `scope-${++state.seq}`,
    boundary:
      Number.isInteger(state.relay?.generation) && state.relay.generation >= 0
        ? state.relay.generation
        : 0,
    epoch:
      Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0,
    intent: intent.trim(),
    stage,
    beginToolCallId: typeof toolCallId === "string" ? toolCallId : "",
    budget: copyCounts(budget),
    remaining: copyCounts(budget),
    spent,
    defers: [],
    residualDefers: [],
    // Measured token accounting for the strict open interior of this scope.
    // null until a real usage message establishes an baseline.
    baseInputTokens: null,
    preBeginInputTokens: null,
    endInputTokens: null,
    endInputTokensPending: false,
    beginResultChars: 0,
    // Model identity fields. Populated by the host integration through
    // beginScope's optional `model` argument; strings or null.
    modelSpec: null,
    modelKey: null,
    previousModelSpec: null,
    previousModelKey: null,
    baseModelKey: null,
  };
}

export function createState() {
  return {
    version: VERSION,
    startedAt: Date.now(),
    seq: 0,
    epoch: 0,
    scopes: [],
    charges: {},
    amends: [],
    collapses: [],
    herdMode: false,
    pins: [],
    relay: createRelay(),
    // Persisted base model identity. The base model lives outside all
    // scopes; the host integration fills these from preparseModelSpec.
    baseModelSpec: null,
    baseModelKey: null,
    // Recovery target written by truncateForHostBoundary when inner scopes
    // are dropped: { targetSpec, expectedKey }. Persisted so a reload can
    // resume the pending switch.
    modelRecovery: null,
    // Provider prompt caches keyed by canonical model key (provider/id).
    // Entries: { cachedUntilPos, lastUsedAt, tokensPerChar } where
    // cachedUntilPos is the exclusive message index the provider still
    // holds. Persisted with the snapshot.
    modelCaches: {},
    // Boolean stage flags: S2/S3/S4 start false, S5 requires all three true,
    // and opening S1 clears them.
    stageFlags: createStageFlags(),
  };
}

/** Make a flow-local view while keeping session fields shared with its owner. */
export function createFlowState(base) {
  const flow = createState();
  const shared = new Set(["herdMode", "relay", "stageFlags", "pins"]);
  for (const key of Object.keys(base)) {
    if (shared.has(key)) {
      Object.defineProperty(flow, key, {
        enumerable: true,
        configurable: true,
        get: () => base[key],
        set: (value) => { base[key] = value; },
      });
    } else {
      put(flow, key, structuredClone(base[key]));
    }
  }
  return flow;
}

// -- Model cache helpers (pure; state.modelCaches is a plain object) -------

function validKey(key) {
  return typeof key === "string" && key !== "";
}

/** Return the cache entry for a canonical key, or null. */
export function modelCacheFor(state, key) {
  if (!state || !isPlainObject(state.modelCaches) || !validKey(key)) return null;
  const entry = state.modelCaches[key];
  return isPlainObject(entry) ? entry : null;
}

/** True when the entry's last use is inside the five-minute TTL. */
export function cacheIsFresh(entry, now = Date.now(), ttl = CACHE_TTL_MS) {
  if (!isPlainObject(entry)) return false;
  const at = Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : null;
  if (at === null || !Number.isFinite(now)) return false;
  return now - at <= ttl;
}

/**
 * Create or update a cache entry. cachedUntilPos is the exclusive message
 * index up to which the provider cache is valid; lastUsedAt refreshes the
 * TTL clock; tokensPerChar is this model's measured token density.
 */
export function touchModelCache(state, key, fields = {}, options = {}) {
  if (!state || typeof state !== "object" || !validKey(key)) return null;
  if (!isPlainObject(state.modelCaches)) state.modelCaches = {};
  const existing = isPlainObject(state.modelCaches[key]) ? state.modelCaches[key] : {};
  const entry = {
    cachedUntilPos:
      Number.isInteger(fields.cachedUntilPos) && fields.cachedUntilPos >= 0
        ? fields.cachedUntilPos
        : (Number.isInteger(existing.cachedUntilPos) ? existing.cachedUntilPos : 0),
    lastUsedAt:
      Number.isFinite(fields.lastUsedAt) && fields.lastUsedAt >= 0
        ? fields.lastUsedAt
        : (Number.isFinite(options.at) && options.at >= 0
            ? options.at
            : (Number.isFinite(existing.lastUsedAt) ? existing.lastUsedAt : Date.now())),
    tokensPerChar:
      Number.isFinite(fields.tokensPerChar) && fields.tokensPerChar >= 0
        ? fields.tokensPerChar
        : (Number.isFinite(existing.tokensPerChar) ? existing.tokensPerChar : null),
  };
  put(state.modelCaches, key, entry);
  return entry;
}

/**
 * Cap every cache's cachedUntilPos at a message index. Used after a
 * physical fold (cap = first removed begin's assistantIndex) or a host
 * boundary (cap = 0): content at or after the cap no longer matches the
 * provider cache. lastUsedAt and tokensPerChar are preserved.
 */
export function capCachePositions(state, maxPos) {
  if (!state || !isPlainObject(state.modelCaches)) return 0;
  const cap = Number.isInteger(maxPos) && maxPos >= 0 ? maxPos : 0;
  let changed = 0;
  for (const key of Reflect.ownKeys(state.modelCaches)) {
    if (typeof key !== "string") continue;
    const entry = state.modelCaches[key];
    if (!isPlainObject(entry)) continue;
    const pos = Number.isInteger(entry.cachedUntilPos) ? entry.cachedUntilPos : 0;
    if (pos > cap) {
      entry.cachedUntilPos = cap;
      changed += 1;
    }
  }
  return changed;
}

/** The tightest wall-clock deadline across the open scope stack, or null. */
export function effectiveDeadline(state) {
  let deadline = null;
  for (const scope of state?.scopes ?? []) {
    if (!Number.isFinite(scope?.deadlineAt)) continue;
    deadline =
      deadline === null ? scope.deadlineAt : Math.min(deadline, scope.deadlineAt);
  }
  return deadline;
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

export {
  VERSION,
  CONTROL_TOOLS,
  isPlainObject,
  isNonEmptyString,
  failure,
  put,
  copyCounts,
  copyDefers,
  makeScope,
};
