// Snapshot bookkeeping for the bracket ledger.
//
// Serializing a ledger used to rebuild every record on every pass. The cache
// here records which parts moved since the last snapshot, so the serializer can
// reuse the record copies that did not move. A ledger nobody registered is not
// cached at all: a hand-built object in a test still serializes by value.
//
// The maps are weak, so a discarded ledger and its records leave no trace. No
// property is added to a ledger or a record: the schema, JSON output, and
// `validLedger` stay exactly as they were.
const ledgers = new WeakMap();
const owners = new WeakMap();

// How many snapshots the change chain may retain. Writes since the last durable
// one are one or two; a handful covers retries. The bound is what keeps the
// cache's own memory proportional to the live ledger instead of the session.
const MAX_STEPS = 8;

function metaOf(ledger) {
  if (!ledger || typeof ledger !== "object") return null;
  return ledgers.get(ledger) ?? null;
}

/**
 * Replace a ledger's turn samples and announce the structural change.
 *
 * A replaced totals object is a new identity, and the shared snapshot reuses
 * the previous ledger copy; without the announcement the next persist would
 * keep the old numbers. The pair lives here once so no caller can set one half.
 */
export function replaceTotals(ledger, totals) {
	if (!ledger || typeof ledger !== "object") return;
	ledger.totals = totals;
	markLedgerStructDirty(ledger);
}

/** Start tracking one ledger. Called where a ledger is born, never by a reader. */
export function registerLedger(ledger) {
  if (!ledger || typeof ledger !== "object") return null;
  let meta = ledgers.get(ledger);
  if (!meta) {
    meta = {
      snapshot: null,
      structDirty: true,
      dirtyForks: new Set(),
      forkRefs: new Map(),
      steps: new WeakMap(),
      // How many records the current snapshot holds. The serializer replaces
      // the id-set check with a count comparison, so a write no longer pays an
      // `Object.keys` pass over the previous snapshot's forks just to learn how
      // many there were. It is written only where a snapshot is built, from the
      // number of records that snapshot actually received.
      snapshotForkCount: 0,
      // What each journal does not have yet, one row per writer.
      //
      // `dirtyForks` is the serializer's own scratch list: it is cleared every
      // time a snapshot is built, because the next build needs to know what
      // moved since *that* build. That made it the wrong source for "what is
      // still unwritten" — after a failed append the mark was already consumed,
      // and the retry had to reconstruct the answer by walking snapshot steps,
      // which fails as soon as the chain is trimmed.
      //
      // A single ledger-wide "unpersisted" set answered the next question wrong
      // in a way that lost data. Two writers can share one ledger while ending
      // their journals at different baselines (a forked session, a replayed
      // branch, a second station over the same scope). One writer's accepted
      // append cleared the shared mark, so the writer that had not yet stored
      // the change computed its increment from a baseline it believed was
      // current — and the change it owed disappeared from that journal with no
      // error, because the tree it wrote was internally consistent.
      //
      // A row per writer cannot make that mistake: it answers "what has *this*
      // writer stored", and nothing another writer does can clear it.
      //
      // Bound: one row per live writer, and the row dies with the ledger (this
      // meta lives in a WeakMap). The id set inside a row is capped — see
      // MAX_PENDING_IDS — so a writer that never flushes cannot grow it without
      // limit; past the cap the row answers "compare exactly", which is always
      // correct.
      consumers: new Map(),
      weakConsumers: new WeakMap(),
      weakConsumerRefs: new Set(),
    };
    ledgers.set(ledger, meta);
  }
  return meta;
}

/** The cache record for one ledger, or null when it is not tracked. */
export function ledgerMeta(ledger) {
  return metaOf(ledger);
}

/** Let a module that holds only a record find the ledger that owns it. */
export function registerRecord(ledger, record) {
  if (!record || typeof record !== "object") return;
  if (!metaOf(ledger)) return;
  // Keep the address assigned at registration. Reading record.forkId later
  // lets a partially failed mutation redirect the dirty mark to another record.
  owners.set(record, { ledger, forkId: record.forkId });
}

// The writer the legacy single-journal API speaks for. Named writers are added
// by `registerConsumer`; the two forms share one code path so a single-writer
// caller keeps exactly the behaviour it had.
const DEFAULT_CONSUMER = "default";

// How many record ids one writer's row may hold before it stops counting.
//
// A writer that never flushes has nothing to lose by comparing exactly, and its
// row must not grow with the session. Past this many distinct records the row
// sets `overflow` and forgets the ids; `consumerPending` then answers null,
// which sends that writer to the exact comparison. Correct, just not
// incremental — the opposite trade from dropping a mark, which would lose data.
const MAX_PENDING_IDS = 4096;

/** One writer's row: what that journal still owes. */
function isWeakConsumer(id) {
  return (typeof id === "object" && id !== null) || typeof id === "function";
}

function findConsumer(meta, id) {
  return isWeakConsumer(id) ? meta.weakConsumers.get(id) : meta.consumers.get(id);
}

function consumerRow(meta, consumerId) {
  let row = findConsumer(meta, consumerId);
  if (!row) {
    row = { records: new Set(), struct: true, overflow: false, revision: 0 };
    if (isWeakConsumer(consumerId)) {
      meta.weakConsumers.set(consumerId, row);
      meta.weakConsumerRefs.add(new WeakRef(row));
    } else {
      meta.consumers.set(consumerId, row);
    }
  }
  return row;
}

function* consumerRows(meta) {
  yield* meta.consumers.values();
  for (const ref of meta.weakConsumerRefs) {
    const row = ref.deref();
    if (row) yield row;
    else meta.weakConsumerRefs.delete(ref);
  }
}

/** Record one id in every row that is still counting. */
function markEveryConsumer(meta, forkId) {
  for (const row of consumerRows(meta)) {
    row.revision += 1;
    if (row.overflow) continue; // it already answers "compare exactly"
    if (row.records.has(forkId)) continue;
    if (row.records.size >= MAX_PENDING_IDS) {
      row.overflow = true;
      row.records.clear();
      continue;
    }
    row.records.add(forkId);
  }
}

/** Register a named writer so it starts owing a baseline. Idempotent. */
export function registerConsumer(ledger, consumerId) {
  const meta = metaOf(ledger);
  if (!meta || (!isWeakConsumer(consumerId) && (typeof consumerId !== "string" || consumerId === ""))) return null;
  return consumerRow(meta, consumerId);
}

/**
 * Forget one writer, as a station does when it closes.
 *
 * Without this a long-lived ledger would keep one row per station that ever
 * touched it. Dropping is safe: a writer that comes back registers again and
 * owes a baseline.
 */
export function dropConsumer(ledger, consumerId) {
  const meta = metaOf(ledger);
  if (!meta) return;
  if (isWeakConsumer(consumerId)) {
    const row = meta.weakConsumers.get(consumerId);
    meta.weakConsumers.delete(consumerId);
    for (const ref of meta.weakConsumerRefs) {
      if (!ref.deref() || ref.deref() === row) meta.weakConsumerRefs.delete(ref);
    }
  } else {
    meta.consumers.delete(consumerId);
  }
}

/**
 * What one writer still owes, read in the size of that writer's work in flight.
 *
 * @returns {{records: string[], struct: boolean} | null} null means "compare
 * exactly": the row overflowed its cap, so no id list can be trusted. A caller
 * must treat null as "the whole tree may have moved", never as "nothing moved".
 */
export function consumerPending(ledger, consumerId = DEFAULT_CONSUMER) {
  const meta = metaOf(ledger);
  if (!meta) return null;
  const row = findConsumer(meta, consumerId);
  if (!row) return { records: [], struct: true };
  if (row.overflow) return null;
  return { records: [...row.records], struct: row.struct, revision: row.revision };
}

/** Revision for acknowledging even an overflowed consumer without clearing newer edits. */
export function consumerRevision(ledger, consumerId = DEFAULT_CONSUMER) {
  const meta = metaOf(ledger);
  return meta ? findConsumer(meta, consumerId)?.revision : undefined;
}

/**
 * One writer's journal accepted a write: that writer owes nothing any more.
 *
 * Cleared for exactly one row, and only after an append succeeded. Clearing
 * before would lose the intent on a failed write — the retry then owes exactly
 * what the failed attempt owed. Clearing every row would be the shared-mark
 * mistake again: it would tell the other writers their changes had landed.
 */
export function commitConsumer(ledger, consumerId = DEFAULT_CONSUMER, expectedRevision) {
  const meta = metaOf(ledger);
  if (!meta) return;
  const row = findConsumer(meta, consumerId);
  if (!row || (expectedRevision !== undefined && row.revision !== expectedRevision)) return;
  row.records.clear();
  row.struct = false;
  row.overflow = false;
}

/** A ledger-level field moved: counters, order, queues, levels, forks. */
export function markLedgerStructDirty(ledger) {
  const meta = metaOf(ledger);
  if (!meta) return;
  meta.structDirty = true;
  // The legacy writer must exist before anything is marked, or a mark taken
  // before the first `ledgerPending` call would land in no row at all.
  consumerRow(meta, DEFAULT_CONSUMER);
  for (const row of consumerRows(meta)) { row.struct = true; row.revision += 1; }
}

/** One record moved. The rest of the ledger keeps its copies. */
export function markRecordDirty(ledger, forkId) {
  const meta = metaOf(ledger);
  if (!meta) return;
  if (typeof forkId === "string" && forkId !== "") {
    meta.dirtyForks.add(forkId);
    consumerRow(meta, DEFAULT_CONSUMER);
    markEveryConsumer(meta, forkId);
  } else {
    markLedgerStructDirty(ledger);
  }
}

/**
 * What the legacy single writer still owes.
 *
 * Kept as its own name because the anchor and the existing tests speak it; it
 * is the default writer's row, not a ledger-wide answer. A ledger with several
 * writers must ask per writer with `consumerPending`.
 */
export function ledgerPending(ledger) {
  return consumerPending(ledger, DEFAULT_CONSUMER);
}

/**
 * The legacy single writer's journal accepted a write.
 *
 * Only that writer's row is cleared. See `commitConsumer` for why clearing
 * every row is the mistake this replaces.
 */
export function commitPersisted(ledger) {
  commitConsumer(ledger, DEFAULT_CONSUMER);
}

/**
 * Record how one snapshot differs from the snapshot it was built from.
  *
  * `changes` names only the records that moved and were copied; pass null when
  * the serializer could not know without comparing every record (a structural
  * rebuild). A null step makes every later net-change question answer null,
  * which sends the caller to the exact comparison instead of a guess.
  */
 export function noteSnapshotStep(ledger, snapshot, previous, changes) {
   const meta = metaOf(ledger);
   if (!meta || !snapshot) return;
   // An unknown step already answers null for everything older than itself,
   // so keeping the older chain would retain snapshots no query can use.
   const link = changes ? (previous ?? null) : null;
   meta.steps.set(snapshot, { previous: link, changes: changes ?? null });
   if (!changes) return;
   // Bound the retained history. Every snapshot keeps its own copy of the
   // fork map, so an unbounded chain — meta.snapshot pins the newest, each
   // step pins its predecessor — would retain one map per write for the life
   // of the process, which is the growth this cache exists to remove. Cutting
   // the tail keeps at most MAX_STEPS snapshots; a query deeper than that
   // falls back to the exact comparison, which is always correct.
   let cursor = link;
   for (let depth = 1; cursor; depth += 1) {
     const step = meta.steps.get(cursor);
     if (!step || !step.changes) return;
     if (depth >= MAX_STEPS - 1) {
       meta.steps.set(cursor, { previous: null, changes: null });
       return;
     }
     cursor = step.previous ?? null;
   }
 }

 /**
  * The net set/del change from `from` to `to`, or null when it cannot be proven.
  *
  * Walking the step chain costs one step per snapshot built since the last
  * durable write — normally one, a couple more when retries stacked up, and
  * never more than the retained bound. So the caller never compares the whole
  * fork map to answer "what moved". Any missing or unknown step, or a `from`
  * off the retained chain, answers null: the caller must then compare, which
  * is always correct, just not incremental.
  */
 export function netChangeSince(ledger, from, to) {
   const meta = metaOf(ledger);
   if (!meta || !from || !to || from === to) return null;
   const set = new Set();
   const del = new Set();
   let cursor = to;
   // A guard, not a policy: a chain this long means the caller is holding a
   // snapshot from another ledger's history, and comparing is the safe answer.
   for (let steps = 0; cursor && cursor !== from && steps < 4096; steps += 1) {
     const step = meta.steps.get(cursor);
     if (!step || !step.changes) return null;
     // The chain is walked newest first, so a record that a newer step already
     // decided must not be re-decided by an older one. Adding blindly and
     // subtracting blindly let the older step win: a fork the newer step
     // re-created after the older step deleted it came out as a deletion, and
     // the caller would drop a live record.
     for (const forkId of step.changes.set) {
       if (set.has(forkId) || del.has(forkId)) continue;
       set.add(forkId);
     }
     for (const forkId of step.changes.del) {
       if (set.has(forkId) || del.has(forkId)) continue;
       del.add(forkId);
     }
     cursor = step.previous ?? null;
   }
   return cursor === from ? { set, del } : null;
 }

 /** Mark the record a caller already holds. The clock and the panhandle receive
 * one record and no ledger, so they reach the cache through this door.
 */
export function touchRecord(record) {
  if (!record || typeof record !== "object") return;
  const owner = owners.get(record);
  if (!owner) return;
  markRecordDirty(owner.ledger, owner.forkId);
}
