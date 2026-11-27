// Ledger entries: decide when a ledger write is owed, and fold a state chain.
// Pure data: plans are computed, never written. No clock, no I/O.

import { VERSION, put } from "./state.mjs";
import { isPlainObject } from "./plain.mjs";
import {
  createBracketLedger,
  serializeLedgerShared,
  ledgerShapeOk,
} from "./forkjoin.mjs";
import { ledgerMeta, markLedgerStructDirty, netChangeSince } from "./ledger-cache.mjs";

import { STATE_ENTRY_VERSION, normalizeStateEntry } from "./entry-plan.mjs";
import { LedgerPatchError, ReplayList, applyArrayOps, applyDelta, applyMapOfArrays, applyOpsInPlace, arrayOps, cloneValue, mapOfArraysOps, putRecordDelta } from "./state-delta.mjs";


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



// Scalars and small maps only. The id lists (`order`, `queues`, `levels`) are
// not here: each holds one entry per fork, so naming one whole costs the
// session's fork count on every write that touches it. They travel as edits.


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


