// The one door through which a fork record is changed in place.
//
// A record is shared: `forkOf` and `registerFork` hand the same object to the
// clock, the panhandle, the return allowance, the send path and the station,
// and each of them writes a different field. A snapshot copies only the records
// it believes have moved, so every one of those writes has to be followed by a
// mark — and a write that forgets is invisible: the change stays in memory, the
// journal keeps the previous copy, and a reload shows the old value with no
// error anywhere.
//
// Collecting the writes here makes the mark part of the write instead of a
// separate thing a caller must remember. `editRecord` runs the mutation and
// then marks the record, always, so a new caller that writes a new field is
// correct by construction rather than by review. It cannot stop a caller that
// reaches the record by another route; what it does is remove every local
// opportunity to forget.
//
// This is not the whole answer to incremental persistence — that needs the
// record's owner to stop handing out writable references at all, and the fork
// map to be a persistent structure. It is the part that belongs to the modules
// that write fields on a record they were given.

import { touchRecord } from "./ledger-cache.mjs";

/**
 * Apply one in-place edit to a record and mark it changed.
 *
 * `edit` receives the record and mutates it. Returning `false` says the edit
 * decided not to change anything (an invalid input, an allowance already
 * spent), and then no mark is written — a snapshot that reported the record as
 * moved would rewrite it for nothing.
 *
 * A falsy record is not an error: callers reach here from paths that may not
 * have a ledger at all (a plain test object, a detached record), and the
 * documented behaviour of those paths is "nothing happened".
 */
export function editRecord(record, edit) {
  if (!record || typeof record !== "object") return false;
  let outcome;
  try {
    outcome = edit(record);
  } catch (error) {
    // The callback may have changed part of the record before it failed.
    // Preserve the exception, but do not let a later snapshot reuse a stale
    // copy of the partially changed record.
    touchRecord(record);
    throw error;
  }
  if (outcome === false) return false;
  touchRecord(record);
  return true;
}

/**
 * Set fields on a record and mark it changed.
 *
 * The shorthand for the common case: a fixed set of values, all of which are
 * part of the same logical step. `undefined` is skipped rather than written,
 * because the serializer drops undefined members and a stored `undefined` would
 * replay as a missing key.
 */
export function setRecordFields(record, fields) {
  return editRecord(record, (target) => {
    let wrote = false;
    for (const key of Object.keys(fields)) {
      const value = fields[key];
      if (value === undefined) continue;
      if (Object.is(target[key], value)) continue;
      target[key] = value;
      wrote = true;
    }
    // Nothing differed: the caller asked for the state the record already had,
    // so there is no change to store.
    return wrote;
  });
}
