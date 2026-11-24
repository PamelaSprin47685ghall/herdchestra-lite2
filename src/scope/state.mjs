// Scope state: creation, inspection, and the base copy helpers.
// Pure data. No I/O.

import { createRelay } from "../relay/state.mjs";
import { createBracketLedger } from "./forkjoin.mjs";

const VERSION = 2;

const CONTROL_TOOLS = new Set([
  "scope_fork",
  "scope_join",
  "scope_return",
  "scope_context",
  // The retired names are never registered now, but an older transcript
  // still carries amend and pin calls that the scan path must process.
  "amend",
  "pin",
]);

// Local cache-freshness estimate, not a provider guarantee. The blueprint
// fixes it at four minutes; longer values count savings on a cache that the
// provider may already have dropped.
export const CACHE_TTL_MS = 4 * 60 * 1000;

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

export function createState() {
  return {
    version: VERSION,
    startedAt: Date.now(),
    seq: 0,
    epoch: 0,
    charges: {},
    amends: [],
    // The bracket tree itself: fork ids, owners, turns, ready order and the
    // frozen record of every child that returned. It is persisted with the
    // state because a reload must be able to close or explain every bracket.
    brackets: createBracketLedger(),
    autopilot: false,
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
    // Entries: { cachedUntilPos, lastUsedAt, tokensPerChar,
    // fixedOverheadTokens } where
    // cachedUntilPos is the exclusive message index the provider still
    // holds, tokensPerChar is the measured density of *dialogue* characters,
    // and fixedOverheadTokens is the part of every input payload that does not
    // come from the dialogue at all (system prompt plus tool schemas).
    // Persisted with the snapshot.
    modelCaches: {},
  };
}

/** Make a flow-local view while keeping session fields shared with its owner. */
export function createFlowState(base) {
  const flow = createState();
  const shared = new Set(["autopilot", "relay", "pins", "brackets"]);
  // A child starts its own receive chain: the parent's receipts belong to the
  // parent's level and must not be folded twice from a child's projection.
  const local = new Set(["receipts"]);
  for (const key of Object.keys(base)) {
    if (local.has(key)) continue;
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
 * TTL clock; tokensPerChar is this model's measured dialogue density;
 * fixedOverheadTokens is the constant prefix (system prompt and tool
 * schemas) that no dialogue character accounts for.
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
    fixedOverheadTokens:
      Number.isFinite(fields.fixedOverheadTokens) && fields.fixedOverheadTokens >= 0
        ? fields.fixedOverheadTokens
        : (Number.isFinite(existing.fixedOverheadTokens)
            ? existing.fixedOverheadTokens
            : null),
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

/** The tightest wall-clock deadline across the branch's own fork, or null. */
export function branchDeadline(record) {
  return record && Number.isFinite(record.deadlineAt) ? record.deadlineAt : null;
}

export {
  VERSION,
  CONTROL_TOOLS,
  isPlainObject,
  isNonEmptyString,
  failure,
  put,
  copyCounts,
};
