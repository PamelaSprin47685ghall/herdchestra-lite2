// Ledger persistence: validate, serialize, and restore the bracket tree.
// Pure data; no clock, no I/O. The tree is a domain fact, so it is stored with
// the scope state and restored with it.

import { isPlainObject } from "./plain.mjs";
import { normalizeTotals } from "./turn-stats.mjs";
import { ledgerMeta, noteSnapshotStep, registerRecord } from "./ledger-cache.mjs";

import { FAILED, JOINED, READY, RUNNING, createBracketLedger, pairingProblems, rehomeReadyResults } from "./ledger-brackets.mjs";
import { forkOf, isDepth, isNonEmptyString, put } from "./ledger-charge.mjs";


// -- Persistence (pure data; no clock, no I/O) ------------------------------
//
// The bracket tree is a domain fact, so it lives in the scope state and is
// restored with it. A process-local Map would make a running child vanish on
// restart and leave an open bracket nobody can close.

const INTERRUPTED_REASON =
  "interrupted by a process restart before the result was received";

const STATUSES = new Set([RUNNING, READY, JOINED, FAILED]);

/**
 * Does a live record still equal the JSON-safe copy a snapshot stored?
 *
 * The previous form copied the record and serialized both sides, so one frame
 * allocated two complete strings of the session's largest record and threw them
 * away. This walks the live value against the stored one instead: no copy, no
 * string, one traversal. It answers exactly what `JSON.stringify(copyData(live))
 * === JSON.stringify(stored)` answered, including the cases that make that
 * question awkward — a value `copyData` would drop counts as absent, an array
 * hole counts as null, and two non-finite numbers are equal because JSON writes
 * both as null.
 */
function sameStoredValue(live, stored) {
  if (live === stored) return true;
  if (live === undefined) return false;
  if (Array.isArray(live)) {
    if (!Array.isArray(stored) || stored.length !== live.length) return false;
    for (let index = 0; index < live.length; index += 1) {
      const child = live[index];
      // `copyData` writes `copyData(item) ?? null`: an absent element and any
      // value JSON cannot hold both become null, so an array of mixed content
      // still compares equal to its stored copy instead of churning the record.
      const wanted = isJsonValue(child) ? child : null;
      if (!sameStoredValue(wanted, stored[index])) return false;
    }
    return true;
  }
  if (isPlainObject(live)) {
    if (!isPlainObject(stored)) return false;
    let count = 0;
    for (const key of Object.keys(live)) {
      const child = live[key];
      // A value the JSON copy cannot hold is not part of the record.
      if (!isJsonValue(child)) continue;
      count += 1;
      if (!Object.hasOwn(stored, key)) return false;
      if (!sameStoredValue(child, stored[key])) return false;
    }
    return count === Object.keys(stored).length;
  }
  if (typeof live === "number" && !Number.isFinite(live)) {
    // JSON writes every non-finite number as null. A stored copy therefore holds
    // `null` where the live record holds NaN or Infinity, and the two are the
    // same value to the journal — comparing them as different would mark the
    // record dirty on every frame and rewrite it for nothing.
    return stored === null || (typeof stored === "number" && !Number.isFinite(stored));
  }
  if (typeof live === "number" && typeof stored === "number") {
    // JSON writes every non-finite number as null, so they are all one value.
    if (!Number.isFinite(live) || !Number.isFinite(stored)) {
      return !Number.isFinite(live) && !Number.isFinite(stored);
    }
  }
  return false;
}

/** Whether `copyData` keeps this value, i.e. whether JSON can hold it. */


/** Whether `copyData` keeps this value, i.e. whether JSON can hold it. */
function isJsonValue(value) {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return true;
  if (kind !== "object") return false;
  if (Array.isArray(value)) return true;
  return isPlainObject(value);
}



function copyData(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => copyData(item) ?? null);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      const copy = copyData(value[key]);
      if (copy !== undefined) put(out, key, copy);
    }
    return out;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}



function validNumberMap(value) {
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



export function validRecord(forkId, record) {
  if (!isPlainObject(record)) return false;
  if (record.forkId !== forkId) return false;
  if (!isNonEmptyString(record.ownerId)) return false;
  if (!isNonEmptyString(record.fsm)) return false;
  if (!isDepth(record.depth)) return false;
  if (!STATUSES.has(record.status)) return false;
  if (!Number.isInteger(record.openSeq) || record.openSeq < 0) return false;
  // The persisted field is named `budget`; its values are turn counts.
  if (!validNumberMap(record.budget)) return false;
  if (!validNumberMap(record.remaining)) return false;
  if (!validNumberMap(record.spent)) return false;
  if (record.record !== null && record.record !== undefined) {
    if (typeof record.record !== "string") return false;
  }
  if (record.reason !== null && record.reason !== undefined) {
    if (typeof record.reason !== "string") return false;
  }
  // Absent is legal: snapshots written before the allowance existed have
  // none, and the readers treat that as zero.
  if (record.returnNudges !== null && record.returnNudges !== undefined) {
    if (!Number.isInteger(record.returnNudges) || record.returnNudges < 0) return false;
  }
  if (record.handoffCount !== null && record.handoffCount !== undefined) {
    if (!Number.isInteger(record.handoffCount) || record.handoffCount < 0) return false;
  }
  // Address and mailbox: absent in older snapshots, but a present value must
  // be the shape the sender and the resolver both assume.
  if (record.path !== null && record.path !== undefined) {
    if (typeof record.path !== "string" || !record.path.startsWith("/")) return false;
  }
  if (record.parentForkId !== null && record.parentForkId !== undefined) {
    if (typeof record.parentForkId !== "string") return false;
  }
  // The branch leaf a resume starts from. Absent is legal (older snapshots); a
  // present value must name an entry, so an empty string is not a tail.
  if (record.branchTail !== null && record.branchTail !== undefined) {
    if (typeof record.branchTail !== "string" || record.branchTail === "") return false;
  }
  return true;
}

/** True when a stored value can rebuild a bracket tree without guessing. */


/** True when a stored value can rebuild a bracket tree without guessing. */
export function validLedger(value) {
  if (!ledgerShapeOk(value)) return false;
  for (const forkId of value.order) {
    if (!validRecord(forkId, value.forks[forkId])) return false;
  }
  return true;
}

/**
 * Everything `validLedger` checks except the per-record field validation.
 *
 * Container shape, counters, the mirror between `order` and `forks`, and the
 * absence of duplicate ids — all in one walk that reads no record field. The
 * per-record walk is the expensive half: a record carries task text, targets,
 * and a return body, and validating each one on every write made a write cost
 * the whole session's fork history.
 *
 * A caller may use this alone only when it also validates every record whose
 * content could have changed. `serializeLedgerShared` does that for exactly
 * the records the ledger names as unsettled, and a record changed without
 * being named cannot reach the journal at all: the snapshot keeps the copy
 * that was already accepted, so the live tree's corruption stays out of the
 * stored history while the shape check still refuses a broken mirror.
 */


/**
 * Everything `validLedger` checks except the per-record field validation.
 *
 * Container shape, counters, the mirror between `order` and `forks`, and the
 * absence of duplicate ids — all in one walk that reads no record field. The
 * per-record walk is the expensive half: a record carries task text, targets,
 * and a return body, and validating each one on every write made a write cost
 * the whole session's fork history.
 *
 * A caller may use this alone only when it also validates every record whose
 * content could have changed. `serializeLedgerShared` does that for exactly
 * the records the ledger names as unsettled, and a record changed without
 * being named cannot reach the journal at all: the snapshot keeps the copy
 * that was already accepted, so the live tree's corruption stays out of the
 * stored history while the shape check still refuses a broken mirror.
 */
export function ledgerShapeOk(value) {
  if (!isPlainObject(value)) return false;
  if (value.version !== 2) return false;
  for (const key of ["seq", "closedSeq", "receiveSeq"]) {
    if (!Number.isInteger(value[key]) || value[key] < 0) return false;
  }
  if (!isPlainObject(value.forks)) return false;
  if (!Array.isArray(value.order)) return false;
  const seen = new Set();
  for (const forkId of value.order) {
    if (!isNonEmptyString(forkId) || seen.has(forkId)) return false;
    seen.add(forkId);
    if (!Object.hasOwn(value.forks, forkId)) return false;
  }
  // A record outside the order cannot be paired or joined; refuse the snapshot
  // instead of restoring a half-addressable tree. The walk above proved every
  // ordered id is a key of `forks`, and it refused a duplicate, so the ordered
  // ids are a subset of the keys with the same cardinality as the ids. For
  // finite sets, subset plus equal size is equality: the key count settles the
  // reverse direction without a second walk and a hash lookup per fork.
  if (Object.keys(value.forks).length !== seen.size) return false;
  if (value.levels !== undefined && !isPlainObject(value.levels)) return false;
  if (value.totals !== undefined && value.totals !== null) {
    if (!isPlainObject(value.totals)) return false;
    const turnMs = value.totals.turnMs;
    const turns = value.totals.turns;
    if (turnMs !== undefined && (!Number.isFinite(turnMs) || turnMs < 0)) return false;
    if (turns !== undefined && (!Number.isFinite(turns) || turns < 0)) return false;
  }
  return true;
}

/**
 * The container half of `validLedger`, without the per-record walk.
 *
 * The fast path in `serializeLedgerShared` reaches here only while the ledger
 * says its structure is clean and its fork id set matches the previous
 * snapshot, so the records that are not listed as dirty were already validated
 * when their copy was made. The records that are dirty still get the full
 * check in the caller, which keeps the guard where the change is.
 */


/**
 * The container half of `validLedger`, without the per-record walk.
 *
 * The fast path in `serializeLedgerShared` reaches here only while the ledger
 * says its structure is clean and its fork id set matches the previous
 * snapshot, so the records that are not listed as dirty were already validated
 * when their copy was made. The records that are dirty still get the full
 * check in the caller, which keeps the guard where the change is.
 */
function validLedgerShallow(value) {
  if (!isPlainObject(value)) return false;
  if (value.version !== 2) return false;
  for (const key of ["seq", "closedSeq", "receiveSeq"]) {
    if (!Number.isInteger(value[key]) || value[key] < 0) return false;
  }
  if (!isPlainObject(value.forks)) return false;
  if (!Array.isArray(value.order)) return false;
  if (value.levels !== undefined && !isPlainObject(value.levels)) return false;
  if (value.totals !== undefined && value.totals !== null) {
    if (!isPlainObject(value.totals)) return false;
    const turnMs = value.totals.turnMs;
    const turns = value.totals.turns;
    if (turnMs !== undefined && (!Number.isFinite(turnMs) || turnMs < 0)) return false;
    if (turns !== undefined && (!Number.isFinite(turns) || turns < 0)) return false;
  }
  return true;
}

/**
 * Capture the explicitly changed fork records for a persistence consumer.
 *
 * `ids` must come from an authoritative change source for that consumer. This
 * function does not infer changes or validate the ledger's containers; callers
 * that cannot prove the id set complete must use the full serializer instead.
 * Each returned record is an independent JSON-safe copy, so later changes to a
 * live record cannot change an already planned write. An invalid record refuses
 * the entire batch rather than turning it into a deletion.
 */


/**
 * Capture the explicitly changed fork records for a persistence consumer.
 *
 * `ids` must come from an authoritative change source for that consumer. This
 * function does not infer changes or validate the ledger's containers; callers
 * that cannot prove the id set complete must use the full serializer instead.
 * Each returned record is an independent JSON-safe copy, so later changes to a
 * live record cannot change an already planned write. An invalid record refuses
 * the entire batch rather than turning it into a deletion.
 */
export function snapshotForkChanges(ledger, ids) {
  if (!isPlainObject(ledger?.forks) || ids == null || typeof ids[Symbol.iterator] !== "function") {
    return { ok: false, reason: "invalid-ledger-changes" };
  }
  const set = {};
  const del = [];
  const seen = new Set();
  for (const id of ids) {
    if (!isNonEmptyString(id)) return { ok: false, reason: "invalid-fork-id" };
    if (seen.has(id)) continue;
    seen.add(id);
    if (!Object.hasOwn(ledger.forks, id)) {
      del.push(id);
      continue;
    }
    const record = ledger.forks[id];
    if (!validRecord(id, record)) return { ok: false, reason: "invalid-record", forkId: id };
    put(set, id, copyData(record));
  }
  return { ok: true, set, del };
}

/** A JSON-safe copy of the tree, safe to persist with the scope state. */


/** A JSON-safe copy of the tree, safe to persist with the scope state. */
export function serializeLedger(ledger) {
  if (!validLedger(ledger)) return copyData(createBracketLedger());
  return copyData(ledger);
}

/**
 * True when every scalar field of the last copy still holds the live value.
 *
 * Container fields are skipped: the copy holds its own containers, so their
 * identity never matches, and a container mutation is caught by the dirty mark
 * the charge, the panhandle, and the amend leave behind.
 */


/**
 * True when every scalar field of the last copy still holds the live value.
 *
 * Container fields are skipped: the copy holds its own containers, so their
 * identity never matches, and a container mutation is caught by the dirty mark
 * the charge, the panhandle, and the amend leave behind.
 */
function settledFields(copy, record) {
  for (const key of Object.keys(record)) {
    const value = record[key];
    // The copy drops undefined fields; their absence is not a change.
    if (value === undefined) continue;
    const previous = copy[key];
    if (value !== null && typeof value === "object") {
      // A container that appeared after the copy must force a new copy. An
      // unchanged container never matches by identity, so its contents are
      // covered by the dirty mark its mutator leaves behind.
      if (!Object.hasOwn(copy, key)) return false;
      continue;
    }
    if (previous !== value) return false;
  }
  return true;
}

/**
 * A JSON-safe copy of the tree that reuses the previous copy of every record
 * that did not move.
 *
 * A caller that mutates the result must use `serializeLedger`: the returned
 * snapshot is shared with the previous one and with the cache, so a write
 * through it would rewrite history. A caller that only reads and persists may
 * use this one, and gets the same object back while nothing has changed.
 */


/**
 * A JSON-safe copy of the tree that reuses the previous copy of every record
 * that did not move.
 *
 * A caller that mutates the result must use `serializeLedger`: the returned
 * snapshot is shared with the previous one and with the cache, so a write
 * through it would rewrite history. A caller that only reads and persists may
 * use this one, and gets the same object back while nothing has changed.
 */
export function serializeLedgerShared(ledger) {
  const meta = ledgerMeta(ledger);
  // Live records and their nested values can also be changed through aliases
  // held by callers. Dirty marks therefore do not prove that the previous copy
  // is current. Compare a complete value copy before reusing any snapshot.
  // This costs O(ledger size); replacing it requires an enforced ownership
  // boundary, not merely a proxy around one of the aliases.
  if (meta && meta.snapshot) {
    // Compare record by record against a JSON-safe copy of that record alone.
    // The former form copied the whole ledger first and compared the copy, so
    // every snapshot held a second complete tree — the transcript included —
    // alive at the same time as the live one. On a session whose history runs
    // to gigabytes that allocation, not the comparison, is the pause the user
    // feels; one record at a time keeps the peak at a record's size while
    // answering exactly what the whole-tree copy answered.
    const old = meta.snapshot;
    const currentIds = Object.keys(ledger.forks);
    const oldIds = Object.keys(old.forks);
    let different = currentIds.length !== oldIds.length;
    if (different || currentIds.some((id, index) => id !== oldIds[index])) {
      meta.structDirty = true;
      different = true;
    }
    // This loop is not an optimisation: it is the only thing that notices a
    // record whose content moved without a record-level mark. A message
    // append is marked as a structural change, not a record one — the tests
    // in tests/ledger-record-diff.test.mjs pin that an append still arrives
    // through this comparison. Skipping it when `structDirty` is already true
    // looks free, because the full rebuild below copies every record anyway,
    // but the diff against the previous snapshot is assembled from what this
    // loop learns. Skipping it there lost an appended message.
    for (const forkId of currentIds) {
      // Compare against the stored copy in place. A record that cannot be
      // edited through an alias is still compared, because the marks are not a
      // proof of ownership — but the comparison no longer allocates a copy of
      // the record and two strings of it.
      if (!sameStoredValue(ledger.forks[forkId], old.forks[forkId])) {
        meta.dirtyForks.add(forkId);
        different = true;
      }
    }
    const currentKeys = [];
    const topCopies = new Map();
    for (const key of Object.keys(ledger)) {
      // Forks are compared record by record above.
      if (key === "forks") {
        currentKeys.push(key);
        continue;
      }
      const copy = copyData(ledger[key]);
      if (copy === undefined) continue;
      currentKeys.push(key);
      topCopies.set(key, copy);
    }
    const oldKeys = Object.keys(old);
    let keysDiffer =
      currentKeys.length !== oldKeys.length ||
      currentKeys.some((key, index) => key !== oldKeys[index]);
    if (!keysDiffer) {
      for (const [key, copy] of topCopies) {
        if (JSON.stringify(copy) !== JSON.stringify(old[key])) {
          keysDiffer = true;
          break;
        }
      }
    }
    if (keysDiffer) {
      meta.structDirty = true;
      different = true;
    }
    if (!different && !meta.structDirty && meta.dirtyForks.size === 0) {
      return meta.snapshot;
    }
  }
  const previous = meta?.snapshot ?? null;
  // Record-level fast path. A clean `structDirty` is the ledger's own claim
  // that no container field and no fork id set changed, so the container
  // copies from the previous snapshot are still exact: reuse them by reference
  // and re-copy only the records that moved. The set check below keeps the
  // claim honest — a fork that appeared or vanished without the mark falls
  // through to the full path instead of being silently dropped or resurrected.
  if (meta && previous && !meta.structDirty) {
    // One pass builds the next snapshot's fork map, so the two checks that
    // used to be separate costs — enumerate the previous snapshot's keys to
    // count them, and spread the old map to start a copy — disappear. The
    // record count comes from the snapshot itself, and each record is either
    // re-copied (it moved) or shared by reference (it did not). The check is
    // exactly as strong as before: every live id must be present in the
    // previous snapshot, and the counts must be equal.
    const forks = {};
    let seen = 0;
    let setsMatch = true;
    const liveKeys = Object.keys(ledger.forks);
    for (const forkId of liveKeys) {
      seen += 1;
      if (meta.dirtyForks.has(forkId)) {
        const record = ledger.forks[forkId];
        if (!validRecord(forkId, record)) {
          setsMatch = false;
          break;
        }
        // A dirty record the previous snapshot never held is a fork that
        // appeared. The fast path reuses the previous container fields, so
        // accepting it would store a tree whose `order` does not name this
        // fork — and a count match cannot see it, because one fork leaving
        // while another arrives is the same number of records. `validLedger`
        // rejects that tree on load and the whole fork history is discarded,
        // so a record that is not in the previous snapshot ends the fast path
        // and sends the write to the structural rebuild, which recomputes the
        // containers from the live tree.
        if (!Object.hasOwn(previous.forks, forkId)) {
          setsMatch = false;
          break;
        }
        put(forks, forkId, copyData(record));
        meta.forkRefs.set(forkId, record);
        continue;
      }
      if (!Object.hasOwn(previous.forks, forkId)) {
        setsMatch = false;
        break;
      }
      put(forks, forkId, previous.forks[forkId]);
    }
    if (setsMatch && seen === meta.snapshotForkCount && validLedgerShallow(ledger)) {
      // Nothing changed, so the copy stands.
      const next = {
        version: ledger.version,
        seq: ledger.seq,
        closedSeq: ledger.closedSeq,
        receiveSeq: ledger.receiveSeq,
        forks,
        order: previous.order,
        queues: previous.queues,
        levels: previous.levels,
        totals: previous.totals,
      };
      const moved = new Set(meta.dirtyForks);
      meta.snapshot = next;
      meta.snapshotForkCount = seen;
      noteSnapshotStep(ledger, next, previous, { set: moved, del: [] });
      meta.dirtyForks.clear();
      return next;
    }
  }
  if (!validLedger(ledger)) return copyData(createBracketLedger());
  if (!meta) return copyData(ledger);
  const forks = {};
  const live = new Set();
  // The rebuild already visits every live id. Preserve its exact record-level
  // result so each persistence baseline can consume it without another walk.
  const set = new Set();
  const del = new Set();
  for (const forkId of Object.keys(ledger.forks)) {
    const record = ledger.forks[forkId];
    live.add(forkId);
    const kept =
      !meta.dirtyForks.has(forkId) &&
      previous?.forks !== undefined &&
      Object.hasOwn(previous.forks, forkId) &&
      meta.forkRefs.get(forkId) === record &&
      settledFields(previous.forks[forkId], record)
        ? previous.forks[forkId]
        : null;
    if (kept) {
      put(forks, forkId, kept);
      continue;
    }
    put(forks, forkId, copyData(record));
    set.add(forkId);
    meta.forkRefs.set(forkId, record);
  }
  // The previous snapshot is the source of truth for removals. The live
  // reference cache can be incomplete when a ledger was externally rebuilt.
  if (previous) {
    for (const forkId of Object.keys(previous.forks)) {
      if (!live.has(forkId)) del.add(forkId);
    }
  }
  for (const forkId of meta.forkRefs.keys()) {
    if (!live.has(forkId)) meta.forkRefs.delete(forkId);
  }
  const next = {
    version: ledger.version,
    seq: ledger.seq,
    closedSeq: ledger.closedSeq,
    receiveSeq: ledger.receiveSeq,
    forks,
    order: copyData(ledger.order),
    queues: copyData(ledger.queues),
    levels: copyData(ledger.levels),
    totals: copyData(ledger.totals),
  };
  meta.snapshot = next;
  meta.snapshotForkCount = live.size;
  meta.structDirty = false;
  // This step is exact even for structural changes: all newly copied records
  // and all removals were recorded while building the snapshot. A first
  // snapshot has no predecessor and therefore cannot serve a delta query.
  noteSnapshotStep(ledger, next, previous, previous ? { set, del } : null);
  meta.dirtyForks.clear();
  return next;
}

/**
 * Rebuild a ledger from a stored snapshot.
 *
 * A running child cannot survive the process. It comes back as a failed ready
 * result: the parent can take it, read why it is empty, and decide whether to
 * re-declare the work. Ready results keep their frozen record and order.
 */


/**
 * Rebuild a ledger from a stored snapshot.
 *
 * A running child cannot survive the process. It comes back as a failed ready
 * result: the parent can take it, read why it is empty, and decide whether to
 * re-declare the work. Ready results keep their frozen record and order.
 */
export function restoreLedgerChecked(value) {
  const out = createBracketLedger();
  if (!validLedger(value)) return { ok: false, ledger: out };
  out.seq = value.seq;
  out.closedSeq = value.closedSeq;
  out.receiveSeq = value.receiveSeq;
  out.totals = normalizeTotals(value.totals);
  for (const forkId of value.order) {
    put(out.forks, forkId, copyData(value.forks[forkId]));
    out.order.push(forkId);
  }
  const storedLevels = isPlainObject(value.levels) ? copyData(value.levels) : {};
  for (const key of Object.keys(storedLevels)) {
    const list = Array.isArray(storedLevels[key])
      ? storedLevels[key].filter((forkId) => forkOf(out, forkId)?.status === JOINED)
      : [];
    if (list.length > 0) put(out.levels, key, list);
  }
  for (const forkId of out.order) {
    const record = out.forks[forkId];
    if (record.status !== RUNNING) continue;
    out.receiveSeq += 1;
    record.status = READY;
    record.readySeq = out.receiveSeq;
    record.outcome = FAILED;
    record.reason = INTERRUPTED_REASON;
    record.closeSeq = null;
    record.closedOrder = null;
  }
  const ready = out.order
    .map((forkId) => out.forks[forkId])
    .filter((record) => record.status === READY && !record.supersededAt)
    .sort((left, right) => (left.readySeq ?? 0) - (right.readySeq ?? 0));
  for (const record of ready) {
    if (!Number.isInteger(record.readySeq) || record.readySeq <= 0) {
      out.receiveSeq += 1;
      record.readySeq = out.receiveSeq;
    } else if (record.readySeq > out.receiveSeq) {
      out.receiveSeq = record.readySeq;
    }
  }
  // A stored owner may have returned before the process ended. Point those
  // results at the nearest live receiver and rebuild the queues in one pass.
  rehomeReadyResults(out);
  // A tree that cannot be addressed consistently is not a partial tree: a
  // queue entry without a fork, or a joined level entry out of order, makes
  // every later take guess. Refuse the snapshot as a whole, exactly as a
  // malformed value is refused, so the session starts from a clean ledger.
  const queueIndex = new Map();
  for (const ownerId of Object.keys(out.queues)) {
    queueIndex.set(ownerId, new Set(out.queues[ownerId]));
  }
  if (!pairingProblems(out, queueIndex).ok) return { ok: false, ledger: createBracketLedger() };
  // The restored records are the live ones from now on; the clock and the
  // panhandle reach the snapshot cache through them.
  for (const forkId of out.order) registerRecord(out, out.forks[forkId]);
  return { ok: true, ledger: out };
}

/**
 * Rebuild a ledger, discarding the tree when its queues and levels do not
 * pair.
 */


/**
 * Rebuild a ledger, discarding the tree when its queues and levels do not
 * pair.
 */
export function restoreLedger(value) {
  return restoreLedgerChecked(value).ledger;
}

