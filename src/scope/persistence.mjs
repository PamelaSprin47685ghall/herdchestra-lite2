// Scope persistence: snapshot validation, serialization, and restoration.
// Pure data. No I/O: the digest below is a computation, not a read.

import { createHash } from "node:crypto";

import {
  VERSION,
  isNonEmptyString,
  put,
  copyCounts,
  createState,
} from "./state.mjs";
import { isPlainObject } from "./plain.mjs";
import { copyRelay, createRelay, isValidRelay } from "../relay/state.mjs";
import {
  createBracketLedger,
  restoreLedgerChecked,
  serializeLedger,
  serializeLedgerShared,
  ledgerShapeOk,
  validLedger,
} from "./forkjoin.mjs";
import { ledgerMeta, markLedgerStructDirty, netChangeSince } from "./ledger-cache.mjs";

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
export function serializeStateShared(state) {
  return serializeStateWith(state, serializeLedgerShared, true, true);
}

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
function serializeStateWith(state, serializeBrackets, _includeAmends = true, share = false) {
  return {
    version: VERSION,
    startedAt: Number.isFinite(state.startedAt) ? state.startedAt : Date.now(),
    seq: state.seq ?? 0,
    brackets: serializeBrackets(state.brackets),
    epoch:
      Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0,
    autopilot: state.autopilot === true,
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

function validTurnCounts(value) {
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
    return {
      version: VERSION,
      startedAt: Number.isFinite(data.startedAt) ? data.startedAt : Date.now(),
      seq: Number.isInteger(data.seq) && data.seq >= 0 ? data.seq : 0,
      epoch:
        Number.isInteger(data.epoch) && data.epoch >= 0 ? data.epoch : 0,
      brackets: restoredBrackets.ledger,
      autopilot: data.autopilot === true,
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

export const STATE_ENTRY_VERSION = 3;
// Version 2 envelopes carry the whole bracket ledger inside `state`; version 3
// moves it into its own append-only entries. Both are readable.
const READABLE_ENTRY_VERSIONS = new Set([2, 3]);
export const CHECKPOINT_EVERY = 64;
export const MAX_DELTA_OPS = 32;
export const MAX_DELTA_BYTES = 16 * 1024;

/**
 * The longest stretch of journal entries one checkpoint may leave behind it.
 *
 * `CHECKPOINT_EVERY` bounds state *writes*, and that is not the same quantity:
 * a turn that moves only a fork record appends an entry the reader must fold
 * through, without advancing that counter at all. A session that moves records
 * far more often than it moves the core therefore reached the reader's replay
 * window with its last checkpoint hundreds of entries behind it.
 *
 * The reader's window is a fixed number of entries (`station/restore.mjs`), so
 * the writer's bound has to be measured in entries too. 256 leaves the window
 * half its length in hand: the writer appends the checkpoint by then, and an
 * entry the writer never saw — a host-side entry, a legacy straggler — can
 * consume the rest. Raising this above the reader's window would make the
 * checkpoint the writer is sure to write land too late to be folded from, which
 * is the failure this constant exists to prevent.
 */
export const CHECKPOINT_ENTRY_LIMIT = 256;

function isStateEnvelope(value) {
  return (
    isPlainObject(value) &&
    READABLE_ENTRY_VERSIONS.has(value.version) &&
    (value.kind === "checkpoint" ||
      value.kind === "delta" ||
      value.kind === "ledger" ||
      value.kind === "amends")
  );
}

/** True when the entry carries fork ledger records instead of scope state. */
export function isLedgerEntry(value) {
  return isStateEnvelope(value) && value.kind === "ledger";
}


/** True when an entry can anchor a replay: a checkpoint or a legacy snapshot. */
export function isStateCheckpoint(value) {
  if (!isStateEnvelope(value)) return true;
  return value.kind === "checkpoint";
}

/** Wrap any stored payload as an envelope a chain reader understands. */
export function normalizeStateEntry(value) {
  if (isStateEnvelope(value)) return value;
  return {
    version: STATE_ENTRY_VERSION,
    kind: "checkpoint",
    state: value,
  };
}

/** Operations that turn `prev` into `next`. Both are serialized states. */
export function diffState(prev, next) {
  const ops = [];
  diffInto(prev, next, [], ops);
  return ops;
}

// `path` is a stack, not a value: a node that turns out unchanged must not cost
// an array. The stored records are copies, so a walk over a record that did not
// move never meets an identical object and visits every node of it — for a
// transcript that is one allocation per field, to discover an empty difference.
// Pushing and popping keeps the allocation to the operations actually emitted,
// and each emitted path is copied so the entry holds the same array it held
// before.
/**
 * The digest an append carries as its witness.
 *
 * A suffix operation cannot restate the text it extends, so it carries a
 * pointer to that text: the length (`from`) and a digest of the whole text
 * (`digest`). The length alone was unsound — a record rewritten to a different
 * text of the same length accepted the append and came back as the wrong text
 * with the right length, which reads as a healthy fork. A tail of the text was
 * better but still a sample: a base that diverged only in the part before the
 * tail passed, and the reader gained the suffix of a text it never had.
 *
 * A digest of the entire text is the smallest witness that covers every
 * character. It costs one pass over the base on each side — the writer already
 * reads the whole base to prove the prefix, and the reader concatenates the
 * whole base anyway — so it changes no asymptotic, and it adds 64 characters
 * to an entry whose suffix is already kilobytes.
 *
 * Two texts of equal length and equal digest are the same text, up to a
 * SHA-256 collision, which is treated here as impossible. That is a stronger
 * statement than "the same tail", and it is the one a restore needs: an append
 * either lands on the exact text it was written for, or the chain fails.
 */
// The digest a text already answered, with the hash state that produced it.
//
// A growing record is hashed once per write: the writer proves its written base
// is a prefix of the live text, and that same text becomes the base of the next
// write. Rehashing it each time is O(L) bytes per persist and Θ(L²) over a
// session, and — the part a reader feels — `Buffer.from(text, "utf16le")`
// allocates two bytes per code unit on every one of those passes.
//
// Keeping the un-terminated hash next to the digest turns the next write into an
// update of the suffix alone: `hash.copy()` digests the base without ending the
// state, and the same state is extended by the new tail. The stored text is a
// reference to a string the ledger already holds, never a copy, so the cache
// costs one small record per entry instead of the transcript's bytes.
//
// Bounded on purpose. One persist touches a handful of records — the fork that
// moved, its owner's snapshot, a replay — so eight entries hold what is in
// flight; an evicted answer only pays the hash it paid before.
const DIGEST_LIMIT = 8;
const digests = new Map();

function rememberDigest(text, entry) {
  digests.delete(text);
  digests.set(text, entry);
  while (digests.size > DIGEST_LIMIT) {
    const oldest = digests.keys().next();
    if (oldest.done) break;
    digests.delete(oldest.value);
  }
  return entry;
}

/**
 * The digest of `base` and of `base + suffix` from one pass over `base`.
 *
 * On a cache hit the base costs nothing and only the suffix is read. On a miss
 * the base is read once; the state is then extended with the suffix, so the
 * caller still pays one traversal of each instead of two traversals of the
 * whole result. The extended state is remembered for whichever write extends
 * `base + suffix` next.
 */
function digestAppend(base, suffix) {
  const hit = digests.get(base);
  const tail = Buffer.from(suffix, "utf16le");
  if (hit) {
    rememberDigest(base, hit);
    const extended = hit.hash.copy().update(tail);
    return { digest: hit.digest, extendedDigest: extended.copy().digest("hex"), extended };
  }
  const hash = createHash("sha256").update(Buffer.from(base, "utf16le"));
  const digest = hash.copy().digest("hex");
  rememberDigest(base, { digest, hash });
  const extended = hash.copy().update(tail);
  return { digest, extendedDigest: extended.copy().digest("hex"), extended };
}

function digestText(text) {
  const hit = digests.get(text);
  if (hit) return rememberDigest(text, hit).digest;
  // Encoded as UTF-16LE code units, not UTF-8.
  //
  // This witness has to be injective on JavaScript strings: its only job is to
  // say which text an append extends, so two strings it cannot tell apart are
  // two strings a restore cannot tell apart. UTF-8 is not injective here. It
  // cannot represent an unpaired surrogate, so the encoder substitutes U+FFFD
  // and `"\uD800"` hashes exactly like `"\uFFFD"` — two different one-character
  // records, one digest. A record can hold either: `JSON.parse` returns a lone
  // surrogate intact, so tool output and model text reach this function with
  // them.
  //
  // UTF-16LE writes each code unit as two bytes with no substitution and no
  // interpretation, so distinct strings always produce distinct byte strings,
  // and SHA-256 over distinct byte strings is the only collision left — the one
  // already assumed impossible. Neither pass reads the text twice: the encoder
  // is a single traversal, which the writer's `startsWith` prefix check already
  // costs and the reader's concatenation already costs.
  return createHash("sha256").update(Buffer.from(text, "utf16le")).digest("hex");
}

const APPEND_DIGEST_HEX = 64;

function diffInto(prev, next, path, ops) {
  if (prev === next) return;
  // A record's transcript is one string that only grows: the renderer re-emits
  // the whole text and the new text begins with the old one. Writing that as a
  // `set` re-sends the record on every turn, so a long-running scope pays for
  // its entire history on each write and the journal grows with the square of
  // it. When the old text is provably a prefix of the new one, the suffix is
  // the whole difference, and the reader rebuilds the same string.
  //
  // The prefix test is what makes this exact rather than optimistic: a
  // re-render that changed an earlier character fails it and keeps the full
  // `set`. `startsWith` reads the old text once — cheaper than serializing it
  // into a journal entry, and the comparison is the only way to know the two
  // texts agree on their common part.
  if (
    typeof prev === "string" &&
    typeof next === "string" &&
    next.length > prev.length &&
    path.length > 0 &&
    next.startsWith(prev)
  ) {
    // One pass over the base, extended by the suffix. The entry carries the
    // digest of `prev`; the state after the suffix is remembered, so the write
    // that extends `next` pays for its own tail and nothing it already read.
    const suffix = next.slice(prev.length);
    const witness = digestAppend(prev, suffix);
    rememberDigest(next, { digest: witness.extendedDigest, hash: witness.extended });
    ops.push({
      op: "append",
      path: path.slice(),
      from: prev.length,
      // `from` says how long the text was, not which text it was, and a tail
      // says how it ended. The digest says which text it was. A reader holding
      // a different text is caught by the applier rather than gaining the
      // suffix of a record it never had, so an append can only ever land on the
      // exact base it was written for.
      digest: witness.digest,
      text: suffix,
    });
    return;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    const common = Math.min(prev.length, next.length);
    for (let index = 0; index < common; index += 1) {
      if (prev[index] === next[index]) continue;
      path.push(index);
      diffInto(prev[index], next[index], path, ops);
      path.pop();
    }
    for (let index = common; index < next.length; index += 1) {
      path.push(index);
      ops.push({ op: "set", path: path.slice(), value: next[index] });
      path.pop();
    }
    if (next.length < prev.length) {
      ops.push({ op: "trunc", path: path.slice(), length: next.length });
    }
    return;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    for (const key of Object.keys(next)) {
      if (Object.hasOwn(prev, key)) {
        if (prev[key] === next[key]) continue;
        path.push(key);
        diffInto(prev[key], next[key], path, ops);
        path.pop();
      } else {
        path.push(key);
        ops.push({ op: "set", path: path.slice(), value: next[key] });
        path.pop();
      }
    }
    for (const key of Object.keys(prev)) {
      if (!Object.hasOwn(next, key)) {
        path.push(key);
        ops.push({ op: "del", path: path.slice() });
        path.pop();
      }
    }
    return;
  }
  ops.push({ op: "set", path: path.slice(), value: next });
}

/**
 * Put one changed record into a ledger entry.
 *
 * A record carries the conversation — its messages, inbox, budget — so writing
 * the whole record for every change to its status wrote the transcript again
 * each time. A change is therefore written as a field diff, in a field of its
 * own: `patches[forkId]` holds the operations and `set[forkId]` holds a whole
 * record. Two fields, two meanings, no marker to trust and no value to inspect —
 * a record that happens to contain a field named `$ops` is data in `set`, and
 * nothing will ever read it as an instruction.
 *
 * A record with no predecessor has nothing to diff against, so it travels in
 * `set`; an entry written before patches existed carries only `set` and reads
 * exactly as it always did.
 */
function putRecordDelta(set, patches, forkId, previous, next) {
  if (isPlainObject(previous) && isPlainObject(next)) {
    put(patches, forkId, diffState(previous, next));
    return true;
  }
  put(set, forkId, next);
  return true;
}

/**
 * A patch that names a record the chain never established.
 *
 * Raised inside folding and turned into a `null` result there. A patch cannot
 * rebuild a record from nothing: applying it to `{}` keeps the changed fields
 * and loses the rest, which reads as a healthy fork whose history is gone. The
 * chain therefore fails as a whole — and it fails as a value, because a reader
 * that inspects a subset of the journal must be able to report that instead of
 * handing the host an exception.
 */
class LedgerPatchError extends Error {}

function cloneValue(value) {
  if (typeof structuredClone !== "function") return JSON.parse(JSON.stringify(value));
  try {
    return structuredClone(value);
  } catch (error) {
    // A mailbox is a proxy, and `structuredClone` refuses a proxy. Hand it a
    // graph in which the mailboxes are plain arrays and everything else is
    // still itself: an object that also holds a `Date`, a `Map` or a cycle is
    // then cloned by `structuredClone` and keeps those values. Rewriting the
    // whole graph through JSON instead would turn a `Date` into a string and a
    // `Map` into `{}` — a lossy copy that still looked successful.
    if (!containsInbox(value)) throw error;
    try {
      return structuredClone(replaceInboxes(value, new Map()));
    } catch {
      // A mailbox nested inside a value `structuredClone` cannot rebuild at all
      // (a `Map` holding an inbox). JSON is the last resort, and it is the old
      // behaviour for exactly this shape.
      return JSON.parse(JSON.stringify(value));
    }
  }
}

/**
 * The same graph with every closed mailbox replaced by a plain array.
 *
 * Only the containers on the path to a mailbox are rebuilt; everything else is
 * passed through by reference, which is what lets `structuredClone` keep
 * handling `Date`, `Map`, `Set` and cycles itself. The map closes cycles among
 * the rebuilt containers, so a ledger that refers to itself still clones.
 */
function replaceInboxes(value, rebuilt) {
  if (value === null || typeof value !== "object") return value;
  const known = rebuilt.get(value);
  if (known !== undefined) return known;
  if (isAppendOnlyInbox(value)) {
    const out = [];
    rebuilt.set(value, out);
    for (const entry of value) out.push(replaceInboxes(entry, rebuilt));
    return out;
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    rebuilt.set(value, out);
    for (let index = 0; index < value.length; index += 1) {
      out[index] = replaceInboxes(value[index], rebuilt);
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  // `Date`, `Map`, `Set`, `RegExp`, typed arrays: leave them to the cloner.
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  rebuilt.set(value, out);
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, {
      value: replaceInboxes(value[key], rebuilt),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Whether an inbox appears anywhere in `value`; the graph may be cyclic. */
function containsInbox(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return false;
  if (isAppendOnlyInbox(value)) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((child) => containsInbox(child, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.keys(value).some((key) => containsInbox(value[key], seen));
}

/**
 * Apply operations to `root` in place.
 *
 * Every written value is cloned first, so no operation payload is ever aliased
 * into `root`. Mutating the result later cannot corrupt the stored operations,
 * and reusing the same `ops` twice cannot corrupt the result.
 */
function applyOpsInPlace(root, ops) {
  if (!Array.isArray(ops)) return root;
  for (const op of ops) {
    if (!Array.isArray(op?.path) || op.path.length === 0) {
      // An append names the text it extends and the length it expects. Without
      // a path there is no text, so the operation is malformed rather than
      // unreadable: skipping it would drop a suffix the writer recorded as
      // applied. Every other op name is skipped, as it always was.
      if (op?.op === "append") {
        throw new LedgerPatchError("append carries no path");
      }
      continue;
    }
    if (op.op === "trunc") {
      // A truncation names the array itself, not a key inside it.
      let target = root;
      for (const key of op.path) {
        target = target?.[key];
        if (target === undefined || target === null) break;
      }
      if (Array.isArray(target)) target.length = op.length;
      continue;
    }
    let parent = root;
    for (let index = 0; index < op.path.length - 1; index += 1) {
      parent = parent?.[op.path[index]];
      if (parent === undefined || parent === null) break;
    }
    if (parent === undefined || parent === null) {
      // A `set`/`del` that names a path the reader does not hold is skipped, as
      // it always was: an entry may name a container another entry creates, and
      // an older journal relies on that tolerance.
      //
      // An `append` cannot take that treatment. It carries a suffix and the
      // length of the text it extends, so a missing container means the record
      // it extends is not in this chain — and skipping would leave the fork
      // absent, or its transcript stopping before the turn that was appended,
      // with nothing downstream able to tell that from work never written. The
      // chain fails as a whole instead, exactly as a patch with no record to
      // apply to does, and the caller falls back to an earlier checkpoint.
      if (op.op === "append") {
        throw new LedgerPatchError(
          `append at ${op.path.join(".")} has no container to extend`,
        );
      }
      continue;
    }
    const key = op.path[op.path.length - 1];
    if (op.op === "set") {
      parent[key] = cloneValue(op.value);
    } else if (op.op === "append") {
      // `from` is the length of the text the writer saw, so the concatenation
      // is only performed on that exact base.
      //
      // A base of another length means the chain and this operation disagree,
      // and there is no repair: the operation carries a suffix, not the text.
      // Skipping it — the treatment a missing parent gets above — would leave
      // the record holding the text it had before the append, which is a
      // *shorter* record that still reads as a healthy fork with its latest
      // turn missing. That is indistinguishable from a fork whose work was
      // never written, so it must not be reported as a value that loaded. The
      // chain fails as a whole instead, exactly as a patch with no record to
      // apply to does, and the caller falls back to an earlier checkpoint.
      //
      // An unknown op name is still skipped silently: that is a reader older
      // than the writer, and it cannot do better than ignore what it cannot
      // interpret. An append it *does* recognize must be exact or absent.
      const base = parent[key];
      // The digest names the exact text the writer extended. `from` alone could
      // not tell two texts of one length apart, and a tail could not tell apart
      // two texts that agree on their ending — either way a reader whose record
      // diverged would take the suffix and hold the wrong text with the right
      // length, which reads as a healthy fork, the one outcome a restore must
      // never produce. An append that cannot show its digest is refused for the
      // same reason: it cannot be proven, and the cost of refusal is a fall back
      // to an earlier checkpoint.
      const sound =
        typeof base === "string" &&
        Number.isInteger(op.from) &&
        op.from >= 0 &&
        base.length === op.from &&
        typeof op.text === "string" &&
        typeof op.digest === "string" &&
        op.digest.length === APPEND_DIGEST_HEX &&
        op.digest === digestText(base);
      if (!sound) {
        throw new LedgerPatchError(
          `append at ${op.path.join(".")} does not meet the text it extends`,
        );
      }
      parent[key] = base + op.text;
    } else if (op.op === "del") {
      delete parent[key];
    }
  }
  return root;
}

/** Apply operations to a copy of `base`. The input is never mutated. */
export function applyDelta(base, ops) {
  return applyOpsInPlace(cloneValue(base), ops);
}

/**
 * Choose the next entry for `next`.
 *
 * Returns null when nothing changed, so an idle turn writes nothing.
 */
export function planStateEntry(prev, next, writesSinceCheckpoint = 0) {
  if (!prev) {
    return { version: STATE_ENTRY_VERSION, kind: "checkpoint", state: next };
  }
  const ops = diffState(prev, next);
  if (ops.length === 0) return null;
  const bytes = JSON.stringify(ops).length;
  if (
    writesSinceCheckpoint >= CHECKPOINT_EVERY - 1 ||
    ops.length > MAX_DELTA_OPS ||
    bytes > MAX_DELTA_BYTES
  ) {
    return { version: STATE_ENTRY_VERSION, kind: "checkpoint", state: next };
  }
  return { version: STATE_ENTRY_VERSION, kind: "delta", ops };
}

/**
 * Split a serialized state into the fields every write copies and the bracket
 * ledger, which changes only where a fork moved.
 *
 * The ledger is the part that grows with the session. Keeping it out of the
 * checkpoint is what stops a checkpoint from costing the whole history.
 */
export function splitState(full) {
  const { brackets, ...core } = full;
  return { core, brackets };
}

/**
 * The ledger's own append-only entry for this write: only the records whose
 * shared copy moved, plus the container fields when one of them moved.
 *
 * Returns null when no fork changed, so an idle write stores no ledger bytes.
 * Record copies come from `serializeLedgerShared`, so an unchanged record is
 * the same object as in the previous entry and costs no bytes to name.
 */
/**
 * The edit that turns `previous` into `next` for an id list, or null when they
 * are the same list.
 *
 * Lists in the ledger are append-ordered and lose entries by id: a fork is
 * registered at the end and removed in place. Written whole into every entry,
 * a list of F ids costs F bytes on every write — the quadratic head growth that
 * made one session's journal outgrow its conversations. As an append/remove
 * pair it costs what actually changed.
 *
 * `reset` is the fallback for a list that moved, reordered, or duplicated an
 * id. It is rare, it is still correct, and it keeps the common path incremental.
 */
function arrayOps(previous, next) {
  if (previous === next) return null;
  const prev = Array.isArray(previous) ? previous : [];
  const nxt = Array.isArray(next) ? next : [];
  const nextIds = new Set(nxt);
  const kept = [];
  const remove = [];
  for (const id of prev) {
    if (nextIds.has(id)) kept.push(id);
    else remove.push(id);
  }
  // Only a pure prefix-preserving append can be replayed incrementally: any
  // reorder or duplicate would fold into a different list.
  let append = null;
  if (kept.length <= nxt.length && new Set(prev).size === prev.length && nextIds.size === nxt.length) {
    append = [];
    for (let index = 0; index < kept.length; index += 1) {
      if (nxt[index] !== kept[index]) {
        append = null;
        break;
      }
    }
    if (append !== null) append = nxt.slice(kept.length);
  }
  if (append === null) return { reset: nxt };
  if (remove.length === 0 && append.length === 0) return null;
  return { remove, append };
}

// Fold-private ordered list. Each value maps to all of its nodes because a
// legacy/reset list may contain duplicates: removal removes every occurrence,
// whereas append adds a value only if it is absent. A linked list preserves
// order without filtering the full prefix for every removal.
class ReplayList {
  constructor(values) {
    this.first = null;
    this.last = null;
    this.nodes = new Map();
    for (const value of values) this.insert(value);
  }

  insert(value) {
    const node = { value, prev: this.last, next: null };
    if (this.last) this.last.next = node;
    else this.first = node;
    this.last = node;
    let nodes = this.nodes.get(value);
    if (!nodes) this.nodes.set(value, nodes = new Set());
    nodes.add(node);
  }

  remove(value) {
    const nodes = this.nodes.get(value);
    if (!nodes) return;
    for (const node of nodes) {
      if (node.prev) node.prev.next = node.next;
      else this.first = node.next;
      if (node.next) node.next.prev = node.prev;
      else this.last = node.prev;
    }
    this.nodes.delete(value);
  }

  toArray() {
    const out = [];
    for (let node = this.first; node; node = node.next) out.push(node.value);
    return out;
  }
}

/** Apply one `arrayOps` result to a fold-private list. */
function applyArrayOps(base, ops) {
  if (!isPlainObject(ops)) return base;
  if (Array.isArray(ops.reset)) return new ReplayList(ops.reset);
  const out = base instanceof ReplayList ? base : new ReplayList(Array.isArray(base) ? base : []);
  if (Array.isArray(ops.remove)) {
    for (const value of ops.remove) out.remove(value);
  }
  if (Array.isArray(ops.append)) {
    for (const value of ops.append) {
      if (!out.nodes.has(value)) out.insert(value);
    }
  }
  return out;
}

/**
 * Per-owner list edits, for `queues`.
 *
 * An owner that gained or lost ids pays for those ids; an owner that did not
 * move is not named at all.
 */
function mapOfArraysOps(previous, next) {
  // Unchanged containers retain their snapshot identity. Avoid enumerating
  // every owner when only a fork record changed.
  if (previous === next) return null;
  const prev = isPlainObject(previous) ? previous : {};
  const nxt = isPlainObject(next) ? next : {};
  const owners = {};
  const removed = [];
  for (const owner of Object.keys(nxt)) {
    const hadOwner = Array.isArray(prev[owner]);
    const ops = arrayOps(prev[owner], nxt[owner]);
    if (ops) {
      put(owners, owner, ops);
      continue;
    }
    // A key that appears is a change even when its list is empty: `arrayOps`
    // sees two empty lists and reports nothing to do, which would leave the
    // owner out of the journal. After a restart the ledger then lacks a key it
    // had, and the next `list.push()` on it throws instead of queueing.
    if (!hadOwner) {
      const list = Array.isArray(nxt[owner]) ? nxt[owner] : [];
      put(owners, owner, { remove: [], append: list.slice() });
    }
  }
  for (const owner of Object.keys(prev)) {
    if (!Object.hasOwn(nxt, owner)) removed.push(owner);
  }
  if (Object.keys(owners).length === 0 && removed.length === 0) return null;
  return { owners, removed };
}

function applyMapOfArrays(base, ops) {
  if (!isPlainObject(ops)) return base;
  // The fold owns this map: baselines and resets are cloned before they enter
  // the working tree. Mutating it avoids copying every owner on each small
  // queue or level change; the input journal remains untouched.
  const out = isPlainObject(base) ? base : {};
  if (Array.isArray(ops.removed)) {
    for (const owner of ops.removed) delete out[owner];
  }
  if (isPlainObject(ops.owners)) {
    for (const owner of Object.keys(ops.owners)) {
      put(out, owner, applyArrayOps(out[owner], ops.owners[owner]));
    }
  }
  return out;
}

export function planLedgerEntry(state, previousBrackets = null) {
  const brackets = state?.brackets;
  // An invalid live tree serializes to an empty one. Writing that would turn a
  // corrupt in-memory ledger into a deleted fork history, so a write is owed
  // and refused instead: the stored history stays the last readable one.
  //
  // The check is unconditional, and that is deliberate. An earlier version
  // skipped it when the ledger claimed its structure had not moved, on the
  // reasoning that unchanged records were validated when they entered the last
  // accepted snapshot. That reasoning does not hold here, because the live tree
  // and the stored snapshot share the same container objects: `order.push` and
  // `levels[key].push` mutate in place, so a caller can corrupt the tree — and
  // the snapshot it is compared against — without touching any identity this
  // module can observe. A same-length edit of `order` is exactly that case: the
  // array identity is unchanged, the length is unchanged, and the write would
  // be answered "nothing owed" while it stored a tree the loader must refuse.
  // There is no cheap proof that the tree is unchanged, so the check runs and
  // a refusal is reported as one.
  const meta = ledgerMeta(brackets);
  // Containers are mutated in place, so the structural mark is the contract for
  // "they moved". A caller that replaces one without marking it would have the
  // change dropped outright: the incremental serializer reuses the previous
  // snapshot's containers by reference, so the new array would never be named.
  // Identity and length are read here, in constant time, and a change either of
  // them can see is promoted to a structural one. A same-length permutation of
  // `order` is still invisible to this cheap reading — it leaves a *valid* tree,
  // so not even the full check rejects it — and that gap stays the mark's
  // responsibility rather than being papered over here.
  const live = meta?.lastLive ?? null;
  const containersMoved =
    live !== null &&
    (brackets.order !== live.order ||
      brackets.order.length !== live.orderLength ||
      brackets.queues !== live.queues ||
      brackets.levels !== live.levels);
  if (containersMoved && meta && !meta.structDirty) markLedgerStructDirty(brackets);
  // A write that only moved record contents is the common one, and it can be
  // checked in the size of what moved. Every other record was validated when it
  // entered an accepted snapshot and has not been touched since — the serializer
  // shares those objects by reference, and no path here writes into them. So the
  // only records whose validity is in question are the ones the ledger says are
  // owed, and only those are read.
  //
  // The path is taken only when the containers provably did not move. A
  // container change, or a record that vanished from the tree, falls through to
  // the full check: a removal without a container change is exactly the kind of
  // inconsistent tree that check exists to refuse, so it must not be answered
  // from a partial reading.
  // The check is unconditional, and that is deliberate. Containers are mutated
  // in place and shared with the last stored snapshot, so `order[0] = "ghost"`
  // keeps both the array identity and its length while making the tree
  // unreadable. There is no constant-cost proof that the tree is unchanged.
  // Skipping the walk was tried and reverted: it let that equal-length case
  // write a tree the loader refuses, which discards the whole fork history.
  // A same-length permutation of `order` leaves a *valid* tree that not even
  // this check rejects — that gap stays the structural mark's responsibility.
  // The per-record field walk is the expensive half, and it is not needed here.
  // A record whose content moved is validated by the serializer, which reads
  // exactly the records the ledger names as unsettled. A record changed without
  // being named never reaches the journal: the snapshot keeps the copy that was
  // already accepted, so the live tree's corruption cannot be stored. What this
  // check still refuses is the tree that is broken in *shape* — a removed
  // record without a container change, or an `order` whose length and identity
  // look untouched while its contents name a fork that has no record.
  if (!ledgerShapeOk(brackets)) {
    // A refusal is not "nothing owed": the live tree is unreadable and the
    // journal is deliberately left at its last readable state. The caller must
    // be able to tell those apart, or the loss is silent.
    return { entry: null, brackets: previousBrackets, refused: "invalid-ledger" };
  }
  const next = serializeLedgerShared(brackets);
  if (meta) {
    meta.lastLive = {
      order: brackets.order,
      orderLength: brackets.order.length,
      queues: brackets.queues,
      levels: brackets.levels,
    };
  }
  // The record-level walk does not happen here; it happens inside the
  // serializer, which is the only place that knows which records it actually
  // had to read. A structural rebuild there validates the whole tree, and the
  // incremental path validates exactly the records the ledger names as
  // unsettled — a record changed without being named is not written at all, so
  // its corruption cannot reach the journal. What can still reach this line is
  // the serializer's own refusal, which it reports as an empty tree. Writing
  // that would be read as "every fork was deleted" and would discard the stored
  // history — the one outcome the refusal exists to prevent. A live tree that
  // holds records while the snapshot holds none is that case, and the write is
  // refused with a code that says the tree was addressable but its records
  // could not be read.
  if (next !== previousBrackets && Object.keys(next.forks).length === 0) {
    if (Object.keys(brackets.forks).length > 0) {
      return { entry: null, brackets: previousBrackets, refused: "unreadable-ledger" };
    }
  }
  if (previousBrackets !== null && next === previousBrackets) {
    return { entry: null, brackets: next };
  }
  const prevForks = previousBrackets?.forks ?? {};
  const set = {};
  let changed = 0;
  const del = [];
  const patches = {};
  // Ask the serializer's step chain first: it already knows which records it
  // re-copied, so the entry can be built from that set instead of comparing
  // every fork id. A missing step — a structural rebuild, a baseline, a
  // snapshot from another history — answers null and the loop below compares
  // exactly as before.
  // The ledger may be shared by stations with different persisted baselines.
  // A successful write in one station clears the ledger-wide pending set; it
  // cannot prove what another station has persisted. Compare against this
  // caller's baseline instead. Unknown snapshot ancestry falls back to the
  // exact comparison below.
  const net =
    previousBrackets === null
      ? null
      : netChangeSince(brackets, previousBrackets, next);
  if (net) {
    for (const forkId of net.set) {
      if (!Object.hasOwn(next.forks, forkId)) continue;
      if (putRecordDelta(set, patches, forkId, prevForks[forkId], next.forks[forkId])) changed += 1;
    }
    for (const forkId of net.del) {
      if (typeof forkId === "string") del.push(forkId);
    }
  } else {
    for (const forkId of Object.keys(next.forks)) {
      if (prevForks[forkId] === next.forks[forkId]) continue;
      if (putRecordDelta(set, patches, forkId, prevForks[forkId], next.forks[forkId])) changed += 1;
    }
    for (const forkId of Object.keys(prevForks)) {
      if (!Object.hasOwn(next.forks, forkId)) del.push(forkId);
    }
  }
  // A removal changes `order` as surely as a rename does, so the header rides
  // along whenever a record disappears.
  //
  // The decision is made from the two snapshots, never from the live tree's
  // one-shot dirty mark. The serializer clears that mark, so a mark consulted
  // *after* a failed append reads "clean" while the change it stood for is not
  // yet in the journal: the retry would then write the record deltas without
  // the container fields they belong to, and the stored `order` would name no
  // such fork — `validLedger` rejects that chain and the whole history is
  // discarded on the next load. A pure function of (previous, next) cannot be
  // consumed, so a retry is just another write.
  //
  // Identity is exact here because the serializer copies on write: an
  // unchanged container is the previous object itself, and a changed one is a
  // fresh copy.
  // A fresh baseline (first write of a process, or the first after a rebase)
  // has no previous snapshot to subtract from, so its `set` names every live
  // record. Without `full` it would be folded as an increment on top of
  // whatever older ledger entries the branch still holds, and a fork that this
  // process no longer knows about would come back from the dead. `full` says
  // "rebuild from this", so replay is a replacement, not an overlay.
  const full = previousBrackets === null;
  // The two lists that grow with the session are written as edits, not as
  // copies. Everything else in the head is a scalar or a small map, so naming
  // it whole costs the same as comparing it.
  const orderOps = full ? null : arrayOps(previousBrackets.order, next.order);
  const queuesOps = full ? null : mapOfArraysOps(previousBrackets.queues, next.queues);
  const levelsOps = full ? null : mapOfArraysOps(previousBrackets.levels, next.levels);
  const structDirty =
    full ||
    del.length > 0 ||
    orderOps !== null ||
    queuesOps !== null ||
    levelsOps !== null ||
    LEDGER_HEAD_FIELDS.some((field) => previousBrackets[field] !== next[field]);
  if (changed === 0 && del.length === 0 && !structDirty) {
    return { entry: null, brackets: next };
  }
  return {
    entry: {
      version: STATE_ENTRY_VERSION,
      kind: "ledger",
      ...(full ? { full: true } : null),
      // Two fields, two meanings: `patches` names the records this entry edits
      // in place, `set` names the records it replaces whole. Nothing inspects a
      // value to decide which it is, so a record that carries a field named
      // `$ops` or `$patch` of its own is data. Every entry written before this
      // field existed carries only `set`, and reads exactly as it always did.
      ...(Object.keys(patches).length > 0 ? { patches } : null),
      set,
      del,
      // A baseline names the lists whole: there is nothing to subtract from.
      ...(full
        ? { order: next.order, queues: next.queues, levels: next.levels }
        : {
            ...(orderOps ? { orderOps } : null),
            ...(queuesOps ? { queuesOps } : null),
            ...(levelsOps ? { levelsOps } : null),
          }),
      head: structDirty
        ? {
            version: next.version,
            seq: next.seq,
            closedSeq: next.closedSeq,
            receiveSeq: next.receiveSeq,
            totals: next.totals,
          }
        : null,
    },
    brackets: next,
  };
}

function sameJson(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) {
    // `JSON.stringify` renders `undefined` as null in an array and drops the
    // key in an object; the caller never passes a top-level undefined.
    return a === null || b === null;
  }
  if (a === null || b === null) return false;
  const kind = typeof a;
  if (kind !== typeof b) return false;
  if (kind !== "object") {
    return kind === "number" ? !Number.isFinite(a) && !Number.isFinite(b) : false;
  }
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!sameJson(a[index], b[index])) return false;
    }
    return true;
  }
  const keys = Object.keys(a);
  let counted = 0;
  for (const key of keys) {
    const value = a[key];
    if (value === undefined || typeof value === "function" || typeof value === "symbol") continue;
    counted += 1;
    if (!Object.hasOwn(b, key)) return false;
    if (!sameJson(value, b[key])) return false;
  }
  for (const key of Object.keys(b)) {
    const value = b[key];
    if (value === undefined || typeof value === "function" || typeof value === "symbol") continue;
    counted -= 1;
    if (counted < 0) return false;
  }
  return counted === 0;
}

// Scalars and small maps only. The id lists (`order`, `queues`, `levels`) are
// not here: each holds one entry per fork, so naming one whole costs the
// session's fork count on every write that touches it. They travel as edits.
const LEDGER_HEAD_FIELDS = [
  "version",
  "seq",
  "closedSeq",
  "receiveSeq",
  "totals",
];

// Every key a head may carry, including the id lists that older entries wrote
// whole. Folding reads through this list, so an entry from either shape lands.
const LEDGER_HEAD_KEYS = [...LEDGER_HEAD_FIELDS, "order", "queues", "levels"];

function foldLedgerEntry(ledger, entry) {
  // A `full` entry rebuilds the tree from scratch. Older ledger entries stay on
  // the branch forever, so folding them on top of a fresh baseline would
  // resurrect forks the new process has already dropped.
  const base = entry.full === true || ledger === null
    ? cloneValue(createBracketLedger())
    : ledger;
  // A patch is applied only to the record the reader already holds. A patch
  // with no such record cannot rebuild one: applying it to `{}` would keep the
  // changed fields and silently drop the rest — a fork that reads healthy while
  // its history is gone. So the whole entry is checked before anything is
  // written, and the fold fails as one chain rather than half-applying and then
  // reporting. Nothing is left behind: `base` is a copy here, and a caller that
  // catches keeps the state it had.
  // A changed record travels as a field diff, in a field of its own: `patches`
  // names the records this entry edits, `set` names the records it replaces
  // whole. Two fields, two meanings, so no value is ever inspected to decide
  // what it is — a record that carries a field named `$patch` is data, and an
  // entry written before patches existed carries only `set` and reads exactly as
  // it always did.
  //
  // A patch is applied to the record the reader already holds. A patch cannot
  // rebuild a record from nothing: applying it to `{}` keeps the changed fields
  // and loses the rest, which reads as a healthy fork whose history is gone. So
  // the chain fails as a whole — raised here as a value the folding loop turns
  // into `null`, never as an exception a host sees.
  if (isPlainObject(entry.patches)) {
    for (const forkId of Object.keys(entry.patches)) {
      const ops = entry.patches[forkId];
      if (!Array.isArray(ops)) {
        throw new LedgerPatchError(`patch for ${forkId} carries no operations`);
      }
      const before = base.forks[forkId];
      if (!isPlainObject(before)) {
        throw new LedgerPatchError(`patch for ${forkId} has no record to apply to`);
      }
      put(base.forks, forkId, applyDelta(cloneValue(before), ops));
    }
  }
  if (isPlainObject(entry.set)) {
    // Every value here is a whole record: the encoding is the field it sits in.
    for (const forkId of Object.keys(entry.set)) {
      put(base.forks, forkId, cloneValue(entry.set[forkId]));
    }
  }
  if (Array.isArray(entry.del)) {
    for (const forkId of entry.del) {
      if (typeof forkId === "string") delete base.forks[forkId];
    }
  }
  if (isPlainObject(entry.head)) {
    // Every head key is applied, not a fixed list: an entry written before the
    // lists moved into `orderOps` carries `order`/`queues` here, and dropping
    // them would restore a ledger whose `order` disagrees with its forks.
    for (const key of LEDGER_HEAD_KEYS) {
      if (Object.hasOwn(entry.head, key)) put(base, key, cloneValue(entry.head[key]));
    }
  }
  if (Array.isArray(entry.order)) base.order = cloneValue(entry.order);
  if (isPlainObject(entry.queues)) base.queues = cloneValue(entry.queues);
  if (isPlainObject(entry.levels)) base.levels = cloneValue(entry.levels);
  if (entry.orderOps) base.order = applyArrayOps(base.order, entry.orderOps);
  if (entry.queuesOps) base.queues = applyMapOfArrays(base.queues, entry.queuesOps);
  if (entry.levelsOps) base.levels = applyMapOfArrays(base.levels, entry.levelsOps);
  return base;
}

/**
 * Replay a chain, oldest first, into one serialized state.
 *
 * The chain is the only owner of the result, so replay mutates one working
 * tree instead of copying the whole state once per delta: a checkpoint clones
 * its state once, and every following delta patches that tree in place. The
 * input entries are never mutated and never aliased into the result.
 *
 * Ledger entries fold into their own tree and are attached last. A version-2
 * checkpoint still carries its ledger inside `state`, so a chain without
 * ledger entries restores exactly as before.
 *
 * @param {unknown[]} entries Stored payloads, oldest first.
 * @returns {object|null} The state, or null when a delta has no anchor.
 */
export function foldStateChain(entries) {
  let base = null;
  let ledger = null;
  for (const raw of entries) {
    const entry = normalizeStateEntry(raw);
    // An `amends` entry is a retired journal kind: the amend feature is gone,
    // but a journal written before the cutover still carries these lines. It is
    // skipped rather than rejected so an old session still loads.
    if (entry.kind === "amends") continue;
    // A commit carries its ledger increment inside the same entry as its state
    // payload, so one append is one *write unit*: the two halves cannot land
    // apart from each other. The host writes one JSONL line per call and hands
    // it to the OS synchronously, so a killed process loses neither half —
    // they are the same line. That is the guarantee, and it is narrower than
    // "durable": the host does not fsync, so a power loss can tear or drop the
    // trailing line, and a failed disk write is reported to nobody (the host
    // keeps the entry in memory, marks a rewrite, and returns an id). Loading
    // is lenient — a malformed line is skipped and counted, not fatal — so a
    // torn tail costs that one entry's contents, not the history before it.
    if (isPlainObject(entry.ledger)) {
      // A patch that names a record this chain never established fails the
      // chain as a value. Folding is also how a reader inspects a subset of the
      // journal — a branch cut, a checkpoint excluded — and an exception there
      // takes the whole restore down instead of reporting what is missing.
      try {
        ledger = foldLedgerEntry(ledger, entry.ledger);
      } catch (error) {
        if (error instanceof LedgerPatchError) return null;
        throw error;
      }
    }
    if (entry.kind === "ledger") {
      try {
        ledger = foldLedgerEntry(ledger, entry);
      } catch (error) {
        if (error instanceof LedgerPatchError) return null;
        throw error;
      }
      continue;
    }
    if (entry.kind === "delta") {
      if (base === null) return null;
      // The state payload is folded through the same applier the ledger uses,
      // so it can fail the chain for the same reason: an operation that names
      // its own base and does not meet it. A record's transcript is written
      // that way, so this is the path that carries it, and a chain that cannot
      // reproduce the text it claims must not be handed to a caller as a
      // restored state.
      try {
        applyOpsInPlace(base, entry.ops);
      } catch (error) {
        if (error instanceof LedgerPatchError) return null;
        throw error;
      }
    } else {
      base = cloneValue(entry.state);
    }
  }
  if (base === null) {
    // A chain that holds only increments still describes something: the ledger
    // and the retired-beat list are each folded independently of the state
    // payload, so either one alone is a readable fragment.
    if (ledger === null) return null;
    base = { version: VERSION };
  }
  if (ledger !== null) {
    // Materialize only once, after all list edits have been folded. The
    // intermediate ReplayLists never escape or mutate an input journal entry.
    if (ledger.order instanceof ReplayList) ledger.order = ledger.order.toArray();
    for (const key of ["queues", "levels"]) {
      const map = ledger[key];
      if (!isPlainObject(map)) continue;
      for (const owner of Object.keys(map)) {
        if (map[owner] instanceof ReplayList) map[owner] = map[owner].toArray();
      }
    }
    base.brackets = ledger;
  }
  return base;
}

