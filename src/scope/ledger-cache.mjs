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

function metaOf(ledger) {
  if (!ledger || typeof ledger !== "object") return null;
  return ledgers.get(ledger) ?? null;
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
  owners.set(record, ledger);
}

/** A ledger-level field moved: counters, order, queues, levels, forks. */
export function markLedgerStructDirty(ledger) {
  const meta = metaOf(ledger);
  if (meta) meta.structDirty = true;
}

/** One record moved. The rest of the ledger keeps its copies. */
export function markRecordDirty(ledger, forkId) {
  const meta = metaOf(ledger);
  if (!meta) return;
  if (typeof forkId === "string" && forkId !== "") meta.dirtyForks.add(forkId);
  else meta.structDirty = true;
}

/**
 * Mark the record a caller already holds. The clock and the panhandle receive
 * one record and no ledger, so they reach the cache through this door.
 */
export function touchRecord(record) {
  if (!record || typeof record !== "object") return;
  const ledger = owners.get(record);
  if (!ledger) return;
  markRecordDirty(ledger, record.forkId);
}
