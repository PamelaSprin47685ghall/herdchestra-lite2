// Scope persistence entry format: versions, size limits, and entry validation.
// Pure data: constants and structural checks only. No I/O.

import { isPlainObject } from "./plain.mjs";


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


/** True when the entry carries fork ledger records instead of scope state. */
export function isLedgerEntry(value) {
  return isStateEnvelope(value) && value.kind === "ledger";
}


/** True when an entry can anchor a replay: a checkpoint or a legacy snapshot. */



/** True when an entry can anchor a replay: a checkpoint or a legacy snapshot. */
export function isStateCheckpoint(value) {
  if (!isStateEnvelope(value)) return true;
  return value.kind === "checkpoint";
}

/** Wrap any stored payload as an envelope a chain reader understands. */


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
