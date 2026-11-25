// The full ledger check runs only when the structure may have moved.
//
// A write that moved one record leaves every other record exactly as the last
// accepted snapshot held it, so walking all of them answered a question whose
// answer could not have changed. The check still has to catch the case it was
// protecting: a live tree the serializer cannot validate answers with an empty
// ledger, and writing that empty tree would be read as "every fork was
// deleted". These tests drive the record-level write path that no longer runs
// the full check, and pin both halves: the refusal, and the ordinary case that
// must still be written.

import { describe, expect, test } from "bun:test";

import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  markLedgerStructDirty,
  markRecordDirty,
  foldStateChain,
  serializeLedgerShared,
} from "../src/scope/index.mjs";

function freshState() {
  const state = createState();
  state.brackets = createBracketLedger();
  return state;
}

function register(state, forkId) {
  const registered = registerFork(state.brackets, {
    forkId,
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);
  return registered.fork;
}

// An entry names a changed record in `patches` and a record with no predecessor
// in `set`; the records it names are the two sets together.
const recordsNamed = (entry) => ({ ...(entry?.set ?? {}), ...(entry?.patches ?? {}) });

describe("a record-level write without the full check", () => {
  test("one record's text is still written on its own", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    // A baseline establishes the durable snapshot the incremental write
    // subtracts from; it is the write that does run the full check.
    const base = planLedgerEntry(state, null);
    expect(base.entry.full).toBe(true);

    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    const next = planLedgerEntry(state, base.brackets);

    expect(next.entry, "the moved record must be written").toBeTruthy();
    expect(Object.keys(recordsNamed(next.entry))).toEqual(["a"]);
    expect(next.entry.patches.a).toBeArray();
    // The value travels in the diff; the fold below is what proves delivery.
    expect(JSON.stringify(next.entry.patches.a)).toContain("a, edited");
    expect(next.entry.head).toBeNull();

    const folded = foldStateChain([base.entry, next.entry]);
    expect(folded.brackets.forks.a.task).toBe("a, edited");
    expect(Object.keys(folded.brackets.forks).sort()).toEqual(["a", "b"]);
  });

  test("a corrupt record is refused, not written as a deletion of history", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const base = planLedgerEntry(state, null);
    const storedBefore = serializeLedgerShared(state.brackets);

    // A record the journal never accepted: `forkId` disagrees with its key, so
    // `validRecord` refuses it. Nothing marks the structure dirty, so this
    // write takes the path that no longer runs the full check.
    state.brackets.forks.a = { forkId: "not-a" };
    markRecordDirty(state.brackets, "a");

    const next = planLedgerEntry(state, base.brackets);

    // The serializer answers with an empty tree. Writing it would say every
    // fork was deleted; the write is refused and the stored history stands.
    expect(next.entry).toBeNull();
    expect(next.brackets).toBe(base.brackets);

    // What a reload sees is still the last readable history.
    const folded = foldStateChain([base.entry]);
    expect(Object.keys(folded.brackets.forks).sort()).toEqual(["a", "b"]);
    expect(storedBefore.forks.a.task).toBe(undefined);
  });

  test("a structural write still runs the full check and refuses corruption", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    state.brackets.forks.ghost = { forkId: "ghost" };
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    expect(next.entry).toBeNull();
    expect(next.brackets).toBe(base.brackets);
  });

  test("the first write of a process runs the full check", () => {
    const state = freshState();
    state.brackets.forks.bad = { forkId: "bad" };
    // No baseline exists, so the check is owed and the write is refused.
    const plan = planLedgerEntry(state, null);
    expect(plan.entry).toBeNull();
  });
});
