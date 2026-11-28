// Scope state codec: serialize a live state to JSON, and restore one from it.
// Pure data. Structural sharing keeps cold fields on an identity fast path.
// No I/O.

import {
  VERSION,
  put,
  createState,
} from "./state.mjs";
import { isPlainObject } from "../core/primitives.mjs";
import { copyFeatures, normalizeFeatures } from "../features/herd/features.mjs";
import { copyRelay, createRelay, isValidRelay } from "../relay/state.mjs";
import { createBracketLedger } from "./ledger-brackets.mjs";
import {
  restoreLedgerChecked,
  serializeLedger,
  serializeLedgerShared,
} from "./ledger-serialize.mjs";


// -- Structural sharing for cold fields ------------------------------------
//
// `diffState` identifies an unchanged field by object identity. A field that
// is rebuilt on every turn therefore never takes that fast path: the delta
// walker descends into it, compares every scalar, finds nothing, and leaves a
// copy behind for the collector. `modelCaches` is the expensive case, since it
// is rewritten on every request while a turn usually adds nothing.
//
// These caches answer identity for content: a source object whose keys and
// per-key values are the same objects as last time yields the copy already
// made from them. The comparison is Θ(keys) pointer reads with no allocation.
// The returned object is never written through: it is the baseline a delta
// subtracts from, and a caller that mutates a serialized state already has to
// use `serializeState`.

const copyCache = new WeakMap();



function cachedCopy(source, copy) {
  // Arrays are shared too: a rebuilt slice is never identical to the
  // baseline's copy. An element edited in place on the source array changes no
  // reference, so the caller that owns one must pass a new array.
  if (source === null || typeof source !== "object") return copy(source);
  const keys = Reflect.ownKeys(source);
  const hit = copyCache.get(source);
  if (hit && hit.keys.length === keys.length) {
    let same = true;
    for (let index = 0; index < keys.length; index += 1) {
      if (
        hit.keys[index] !== keys[index] ||
        hit.values[index] !== source[keys[index]]
      ) {
        same = false;
        break;
      }
    }
    if (same) return hit.out;
  }
  const out = copy(source);
  const values = keys.map((key) => source[key]);
  copyCache.set(source, { keys, values, out });
  return out;
}

// `modelCaches` is not shared by identity: its entries are rewritten in place
// (`touchModelCache` refreshes `lastUsedAt`), so a reference comparison would
// miss the change; the table holds one entry per model, and rebuilding it costs
// nothing worth a correctness risk.

// Model cache entries: { lastUsedAt, tokensPerChar, fixedOverheadTokens }.


// `modelCaches` is not shared by identity: its entries are rewritten in place
// (`touchModelCache` refreshes `lastUsedAt`), so a reference comparison would
// miss the change; the table holds one entry per model, and rebuilding it costs
// nothing worth a correctness risk.

// Model cache entries: { lastUsedAt, tokensPerChar, fixedOverheadTokens }.
function copyModelCaches(source) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string" || key === "") continue;
    const entry = source[key];
    if (!isPlainObject(entry)) continue;
    const copied = {};
    if (Number.isFinite(entry.lastUsedAt) && entry.lastUsedAt >= 0) {
      put(copied, "lastUsedAt", entry.lastUsedAt);
    }
    if (Number.isFinite(entry.tokensPerChar) && entry.tokensPerChar >= 0) {
      put(copied, "tokensPerChar", entry.tokensPerChar);
    }
    if (Number.isFinite(entry.fixedOverheadTokens) && entry.fixedOverheadTokens >= 0) {
      put(copied, "fixedOverheadTokens", entry.fixedOverheadTokens);
    }
    if (Object.keys(copied).length > 0) put(out, key, copied);
  }
  return out;
}



function copyModelRecovery(source) {
  if (!isPlainObject(source)) return null;
  const out = {};
  if (typeof source.targetSpec === "string" || source.targetSpec === null) {
    put(out, "targetSpec", source.targetSpec ?? null);
  }
  if (typeof source.expectedKey === "string" || source.expectedKey === null) {
    put(out, "expectedKey", source.expectedKey ?? null);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Serialize into objects the caller owns.
 *
 * Every nested table is rebuilt, so a caller may write through the result and
 * an earlier result keeps what it held. This is the contract a caller relies on
 * when it holds two snapshots at once and edits one of them; `serializeStateShared`
 * trades that contract for the delta walker's identity fast path.
 */


/**
 * Serialize into objects the caller owns.
 *
 * Every nested table is rebuilt, so a caller may write through the result and
 * an earlier result keeps what it held. This is the contract a caller relies on
 * when it holds two snapshots at once and edits one of them; `serializeStateShared`
 * trades that contract for the delta walker's identity fast path.
 */
export function serializeState(state) {
  return serializeStateWith(state, serializeLedger, true, false);
}

/**
 * Serialize for the persistence hot path.
 *
 * The bracket tree comes back shared with the previous snapshot of the same
 * ledger: an untouched fork is the same object in both, and an unchanged
 * ledger is not rebuilt at all. The result is read-only and must never be
 * written through, because the previous entry still holds the same records.
 * A caller that writes to a serialized state must use `serializeState`.
 */


/**
 * Serialize for the persistence hot path.
 *
 * The bracket tree comes back shared with the previous snapshot of the same
 * ledger: an untouched fork is the same object in both, and an unchanged
 * ledger is not rebuilt at all. The result is read-only and must never be
 * written through, because the previous entry still holds the same records.
 * A caller that writes to a serialized state must use `serializeState`.
 */
export function serializeStateShared(state) {
  return serializeStateWith(state, serializeLedgerShared, true, true);
}

/**
 * Serialize the non-ledger fields without walking the ledger a second time.
 *
 * Read-only for the same reason as `serializeStateShared`: the tables that did
 * not move come back as the objects a previous call returned.
 */


/**
 * Serialize the non-ledger fields without walking the ledger a second time.
 *
 * Read-only for the same reason as `serializeStateShared`: the tables that did
 * not move come back as the objects a previous call returned.
 */
export function serializeStateCore(state) {
  const { brackets: _brackets, ...core } = serializeStateWith(state, () => null, false, true);
  return core;
}

/**
 * `share` answers whether a table that did not move may come back as the copy
 * a previous call already made. Only the two read-only entry points ask for it;
 * `serializeState` promises objects the caller owns and must copy eagerly.
 */


/**
 * `share` answers whether a table that did not move may come back as the copy
 * a previous call already made. Only the two read-only entry points ask for it;
 * `serializeState` promises objects the caller owns and must copy eagerly.
 */
function serializeStateWith(state, serializeBrackets, _includeAmends = true, share = false) {
  return {
    version: VERSION,
    startedAt: Number.isFinite(state.startedAt) ? state.startedAt : Date.now(),
    seq: state.seq ?? 0,
    brackets: serializeBrackets(state.brackets),
    epoch:
      Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0,
    contextBaselineTokens: validContextBaselineTokens(state.contextBaselineTokens),
    hostBoundaryKey: validHostBoundaryKey(state.hostBoundaryKey),
    features: copyFeatures(state.features),
    relay: copyRelay(state.relay),
    baseModelSpec:
      typeof state.baseModelSpec === "string" ? state.baseModelSpec : null,
    baseModelKey:
      typeof state.baseModelKey === "string" && state.baseModelKey !== ""
        ? state.baseModelKey
        : null,
    modelRecovery: copyModelRecovery(state.modelRecovery),
    modelCaches: share && isPlainObject(state.modelCaches)
      ? cachedCopy(state.modelCaches, copyModelCaches)
      : copyModelCaches(state.modelCaches),
  };
}





// -- Birth baseline and host boundary --------------------------------------
//
// Both persist with the state so a reload restores what the session was born
// with. The nudge midpoint is `(window - birth) / 2 + birth`, so
// re-baselining on reload would ratchet the threshold up on every restart.

const LEGACY_HOST_BOUNDARY = Symbol("herd.legacyHostBoundaryUnknown");

function validContextBaselineTokens(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function validHostBoundaryKey(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * True for a state restored from a snapshot written before the boundary key
 * was persisted. Its first observation adopts the transcript's current
 * boundary silently instead of replaying it as a move. The marker is
 * non-enumerable, so it never reaches a serialized state.
 */
export function hasLegacyUnknownHostBoundary(state) {
  return Boolean(state && state[LEGACY_HOST_BOUNDARY] === true);
}

function validModelCaches(value) {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "") return false;
    const entry = value[key];
    if (!isPlainObject(entry)) return false;
    if (
      entry.lastUsedAt !== undefined &&
      (!Number.isFinite(entry.lastUsedAt) || entry.lastUsedAt < 0)
    ) {
      return false;
    }
    if (
      entry.tokensPerChar !== undefined &&
      (typeof entry.tokensPerChar !== "number" ||
        !Number.isFinite(entry.tokensPerChar) ||
        entry.tokensPerChar < 0)
    ) {
      return false;
    }
  }
  return true;
}



function validModelRecovery(value) {
  if (value === undefined || value === null) return true;
  if (!isPlainObject(value)) return false;
  for (const key of ["targetSpec", "expectedKey"]) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
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
    if (!validModelCaches(data.modelCaches)) return createState();
    if (!validModelRecovery(data.modelRecovery)) return createState();
    for (const key of ["baseModelSpec", "baseModelKey"]) {
      if (
        data[key] !== undefined &&
        data[key] !== null &&
        typeof data[key] !== "string"
      ) {
        return createState();
      }
    }
    const restoredBrackets =
      data.brackets === undefined
        ? { ok: true, ledger: createBracketLedger() }
        : restoreLedgerChecked(data.brackets);
    // A tree whose queues and levels do not pair is not partially loadable, so
    // it is dropped whole.
    if (!restoredBrackets.ok) return createState();
    // A snapshot written before the birth baseline was persisted kept the
    // same number in the root directory meta, so a reload migrates from
    // there. An explicit `null` is a real reset and must win over that older
    // copy; migration only runs when this snapshot lacks the property.
    const hasPersistedBaseline = Object.hasOwn(data, "contextBaselineTokens");
    const contextBaselineTokens = hasPersistedBaseline
      ? validContextBaselineTokens(data.contextBaselineTokens)
      : validContextBaselineTokens(
          restoredBrackets.ledger && restoredBrackets.ledger.root
            ? restoredBrackets.ledger.root.dirContextTokens
            : null,
        );
    // A snapshot written before the boundary key was persisted cannot say
    // which boundary the previous process already absorbed.
    const hasPersistedBoundary = Object.hasOwn(data, "hostBoundaryKey");
    const hostBoundaryKey = hasPersistedBoundary
      ? validHostBoundaryKey(data.hostBoundaryKey)
      : null;
    const storedFeatures = isPlainObject(data.features) ? data.features : null;
    // The retired `autopilot` feature is dropped on purpose: a goal session
    // is per-command, so a restored session never starts inside one.
    const features = normalizeFeatures(storedFeatures ?? {});
    const restored = {
      version: VERSION,
      startedAt: Number.isFinite(data.startedAt) ? data.startedAt : Date.now(),
      seq: Number.isInteger(data.seq) && data.seq >= 0 ? data.seq : 0,
      epoch:
        Number.isInteger(data.epoch) && data.epoch >= 0 ? data.epoch : 0,
      contextBaselineTokens,
      hostBoundaryKey,
      brackets: restoredBrackets.ledger,
      features,
      relay: data.version === VERSION ? copyRelay(data.relay) : createRelay(),
      baseModelSpec:
        typeof data.baseModelSpec === "string" ? data.baseModelSpec : null,
      baseModelKey:
        typeof data.baseModelKey === "string" && data.baseModelKey !== ""
          ? data.baseModelKey
          : null,
      modelRecovery: copyModelRecovery(data.modelRecovery),
      modelCaches: copyModelCaches(data.modelCaches),
    };
    if (!hasPersistedBoundary) {
      Object.defineProperty(restored, LEGACY_HOST_BOUNDARY, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
    return restored;
  } catch {
    return createState();
  }
}

// -- Append-only state entries ---------------------------------------------
//
// The host session is a tree of entries linked by `parentId`, and
// `appendCustomEntry` only ever adds a child. A full snapshot per turn grows
// the session file by the whole state each time. These helpers write what
// changed instead: a delta against the previous snapshot, with a periodic
// checkpoint that bounds replay length.
//
// A checkpoint carries the full serialized state. A delta carries JSON-patch
// style operations over that state. A legacy entry carries the state alone,
// with no envelope, and still restores.

