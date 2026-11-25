// The unsettled set names record content, not the fork id set.
//
// `registerFork` marks the *structure*; it never marks the new record. So a
// write that both edits one record and registers another has an unsettled set
// naming only the edited one. Building the entry from that set omits the new
// fork's record, while the header still writes its id into `order` — a stored
// header naming a fork with no record. The loader refuses that tree, so the
// session's whole fork history is discarded on the next start.
//
// These tests drive the real registration path, and compare the journal against
// what a reload can read: an entry that folds into an invalid ledger is the
// failure, not a missing field in isolation.

import { describe, expect, test } from "bun:test";

import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  splitState,
  serializeStateShared,
  planStateEntry,
  foldStateChain,
  deserializeState,
  markRecordDirty,
  markLedgerStructDirty,
  validLedger,
} from "../src/scope/index.mjs";
import { commitPersisted, registerLedger } from "../src/scope/ledger-cache.mjs";

function freshState() {
  const state = createState();
  state.brackets = createBracketLedger();
  registerLedger(state.brackets);
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

describe("a write that edits a record and registers another", () => {
  test("the new fork's record is written, not just its id", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);
    expect(base.entry.full).toBe(true);
    commitPersisted(state.brackets);

    // One record's content moves, and another fork appears. Registration marks
    // the structure only, so `unpersisted` names "a" and never "b".
    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    register(state, "b");

    const next = planLedgerEntry(state, base.brackets);
    expect(next.refused).toBeUndefined();
    expect(next.entry).toBeTruthy();
    // The entry must carry both: "a" because its content moved, "b" because it
    // exists at all. Naming only "a" would store a header that references a
    // fork with no record.
    expect(Object.keys(recordsNamed(next.entry)).sort()).toEqual(["a", "b"]);
    expect(recordsNamed(next.entry).b.forkId).toBe("b");
    expect(next.entry.patches.a).toBeArray();
    expect(JSON.stringify(next.entry.patches.a)).toContain("a, edited");

    const folded = foldStateChain([base.entry, next.entry].filter(Boolean));
    // The journal must fold into a tree the loader accepts: `order` and `forks`
    // agree, so nothing is discarded on reload.
    expect(validLedger(folded.brackets)).toBe(true);
    expect(Object.keys(folded.brackets.forks).sort()).toEqual(["a", "b"]);
    expect(folded.brackets.order.slice().sort()).toEqual(["a", "b"]);
    // A ledger-only journal is a ledger, not a whole state: `deserializeState`
    // refuses one without its core checkpoint. What this journal owes is the
    // readable tree, and `validLedger` above is that answer — the header and the
    // records agree, so a reload keeps every fork instead of discarding them.
  });

  test("a removal and a record edit travel together", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    register(state, "c");
    const base = planLedgerEntry(state, null);
    commitPersisted(state.brackets);

    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    delete state.brackets.forks.c;
    state.brackets.order = state.brackets.order.filter((id) => id !== "c");
    state.brackets.levels = Object.fromEntries(
      Object.entries(state.brackets.levels).map(([key, list]) => [
        key,
        list.filter((id) => id !== "c"),
      ]),
    );
    markLedgerStructDirty(state.brackets);

    const next = planLedgerEntry(state, base.brackets);
    expect(next.refused).toBeUndefined();
    expect(Object.keys(recordsNamed(next.entry))).toEqual(["a"]);
    expect(next.entry.del).toEqual(["c"]);

    const folded = foldStateChain([base.entry, next.entry].filter(Boolean));
    expect(validLedger(folded.brackets)).toBe(true);
    expect(Object.keys(folded.brackets.forks).sort()).toEqual(["a", "b"]);
    expect(folded.brackets.order).toEqual(["a", "b"]);
  });

  test("a pure record edit still uses the unsettled set", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const base = planLedgerEntry(state, null);
    commitPersisted(state.brackets);

    // Nothing structural: the shortcut is allowed, and it names only the record
    // that moved — the whole point of keeping the set.
    state.brackets.forks.b.task = "b, edited";
    markRecordDirty(state.brackets, "b");
    const next = planLedgerEntry(state, base.brackets);

    expect(Object.keys(recordsNamed(next.entry))).toEqual(["b"]);
    expect(next.entry.head).toBeNull();
    expect(next.entry.orderOps).toBeUndefined();
    expect(next.entry.queuesOps).toBeUndefined();
    expect(next.entry.levelsOps).toBeUndefined();

    const folded = foldStateChain([base.entry, next.entry].filter(Boolean));
    expect(validLedger(folded.brackets)).toBe(true);
    expect(folded.brackets.forks.b.task).toBe("b, edited");
    expect(folded.brackets.forks.a.task).toBeUndefined();
  });

  test("a quiet valid ledger owes nothing", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);
    commitPersisted(state.brackets);

    const quiet = planLedgerEntry(state, base.brackets);
    expect(quiet.refused).toBeUndefined();
    expect(quiet.entry).toBeNull();
  });
});
