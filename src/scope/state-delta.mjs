// Scope state deltas: diff, apply, array and map-of-arrays operations, replay.
// Pure data. No I/O: the digest below is a computation, not a read.

import { createHash } from "node:crypto";

import { put } from "../core/primitives.mjs";
import { isPlainObject } from "../core/primitives.mjs";

import { CHECKPOINT_EVERY, MAX_DELTA_BYTES, MAX_DELTA_OPS, STATE_ENTRY_VERSION } from "./entry-plan.mjs";


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
export function putRecordDelta(set, patches, forkId, previous, next) {
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
export class LedgerPatchError extends Error {}



export function cloneValue(value) {
  if (typeof structuredClone !== "function") return JSON.parse(JSON.stringify(value));
  return structuredClone(value);
}

/**
 * Apply operations to `root` in place.
 *
 * Every written value is cloned first, so no operation payload is ever aliased
 * into `root`. Mutating the result later cannot corrupt the stored operations,
 * and reusing the same `ops` twice cannot corrupt the result.
 */


/**
 * Apply operations to `root` in place.
 *
 * Every written value is cloned first, so no operation payload is ever aliased
 * into `root`. Mutating the result later cannot corrupt the stored operations,
 * and reusing the same `ops` twice cannot corrupt the result.
 */
export function applyOpsInPlace(root, ops) {
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


/** Apply operations to a copy of `base`. The input is never mutated. */
export function applyDelta(base, ops) {
  return applyOpsInPlace(cloneValue(base), ops);
}

/**
 * Choose the next entry for `next`.
 *
 * Returns null when nothing changed, so an idle turn writes nothing.
 */


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
export function arrayOps(previous, next) {
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


// Fold-private ordered list. Each value maps to all of its nodes because a
// legacy/reset list may contain duplicates: removal removes every occurrence,
// whereas append adds a value only if it is absent. A linked list preserves
// order without filtering the full prefix for every removal.
export class ReplayList {
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


/** Apply one `arrayOps` result to a fold-private list. */
export function applyArrayOps(base, ops) {
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


/**
 * Per-owner list edits, for `queues`.
 *
 * An owner that gained or lost ids pays for those ids; an owner that did not
 * move is not named at all.
 */
export function mapOfArraysOps(previous, next) {
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



export function applyMapOfArrays(base, ops) {
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

