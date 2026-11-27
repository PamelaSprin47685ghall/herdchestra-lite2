// Scope state: creation, inspection, and the base copy helpers.
// Pure data. No I/O.

import { defaultFeatures } from "../features/herd/features.mjs";
import {
  copyCounts,
  failure,
  isNonEmptyString,
  isPlainObject,
  put,
} from "../core/primitives.mjs";
import { createRelay } from "../relay/state.mjs";
import { createBracketLedger } from "./ledger-brackets.mjs";

// The state shape's own version. It is not the ledger snapshot version (the
// bracket ledger carries its own) and not the journal envelope version
// (`STATE_ENTRY_VERSION` in entry-plan.mjs); the three evolve apart.
const STATE_VERSION = 2;

// Historical name for the same number, kept because callers and the barrel
// export it.
const VERSION = STATE_VERSION;

const CONTROL_TOOLS = new Set([
  "scope_fork",
  "scope_join",
  "scope_return",
  "scope_abandon",
  "wait",
]);

export function createState() {
  return {
    version: STATE_VERSION,
    startedAt: Date.now(),
    seq: 0,
    epoch: 0,
    // The bracket tree itself: fork ids, owners, budgets, ready order and the
    // frozen record of every child that returned. It is persisted with the
    // state because a reload must be able to close or explain every bracket.
    brackets: createBracketLedger(),
    features: defaultFeatures(),
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
    // Entries: { lastUsedAt, tokensPerChar, fixedOverheadTokens } where
    // tokensPerChar is the measured density of *dialogue* characters and
    // fixedOverheadTokens is the part of every input payload that does not
    // come from the dialogue at all (system prompt plus tool schemas).
    modelCaches: {},
  };
}

/** Make a flow-local view while keeping session fields shared with its owner. */
export function createFlowState(base) {
  const flow = createState();
  // `brackets` is the session's single ledger; `features` and `relay` are
  // session switches every scope reads live.
  const shared = new Set(["features", "relay", "brackets"]);
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

/**
 * Create or update a cache entry. lastUsedAt is when this model was last used;
 * tokensPerChar is this model's measured dialogue density; fixedOverheadTokens
 * is the constant prefix (system prompt and tool schemas) that no dialogue
 * character accounts for.
 */
export function touchModelCache(state, key, fields = {}, options = {}) {
  if (!state || typeof state !== "object" || !validKey(key)) return null;
  if (!isPlainObject(state.modelCaches)) state.modelCaches = {};
  const existing = isPlainObject(state.modelCaches[key]) ? state.modelCaches[key] : {};
  const entry = {
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

/** The tightest wall-clock deadline across the branch's own fork, or null. */
export function branchDeadline(record) {
  return record && Number.isFinite(record.deadlineAt) ? record.deadlineAt : null;
}

export {
  STATE_VERSION,
  VERSION,
  CONTROL_TOOLS,
  isNonEmptyString,
  failure,
  put,
  copyCounts,
};
