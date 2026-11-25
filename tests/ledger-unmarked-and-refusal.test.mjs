// Two ways a ledger write can lie, and the guard for each.
//
// 1. A container changed without the structural mark. The incremental
//    serializer reuses the previous snapshot's containers by reference, so the
//    change would be dropped on every write, forever, while each write answered
//    "nothing owed". The cheap identity/length reading promotes it to a
//    structural write.
//
// 2. The live tree is unreadable. The write is refused — the journal keeps its
//    last readable state — and the refusal must be visible. Reporting it as
//    "nothing owed" is the same lie as writing an empty ledger: the caller never
//    learns that its changes stopped being stored.

import { describe, expect, test } from "bun:test";

import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";
import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  splitState,
  serializeStateShared,
  planStateEntry,
  foldStateChain,
  markRecordDirty,
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

describe("a container that moved without the mark", () => {
  test("a reordered id list is written instead of being dropped forever", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const base = planLedgerEntry(state, null);
    expect(base.entry.full).toBe(true);

    // The same ids, the same count, a new array object, and no structural
    // mark. Without the identity reading the incremental serializer reuses the
    // previous snapshot's `order` by reference, so `arrayOps(previous, next)`
    // compares an object with itself, answers "nothing moved", and the reorder
    // is dropped on this write and on every write after it.
    state.brackets.order = ["b", "a"];
    const plan = planLedgerEntry(state, base.brackets);

    expect(plan.entry, "the reorder must reach the journal").toBeTruthy();
    expect(
      plan.entry.orderOps ?? plan.entry.order,
      "the entry must carry the list it changed",
    ).toBeTruthy();

    const folded = foldStateChain([base.entry, plan.entry].filter(Boolean));
    expect(folded.brackets.order).toEqual(["b", "a"]);
  });

  test("a length change is promoted even when nothing is marked", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    // An in-place append: identity is unchanged, the length is not.
    const record = JSON.parse(JSON.stringify(state.brackets.forks.a));
    record.forkId = "b";
    state.brackets.forks.b = record;
    state.brackets.order.push("b");

    const plan = planLedgerEntry(state, base.brackets);
    expect(plan.entry).toBeTruthy();
    const folded = foldStateChain([base.entry, plan.entry].filter(Boolean));
    expect(folded.brackets.order).toEqual(["a", "b"]);
  });

  test("a silent second write does not re-emit a change the journal already has", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);
    register(state, "b");
    const first = planLedgerEntry(state, base.brackets);
    expect(first.entry).toBeTruthy();

    // Nothing moved since: the write owes nothing. The guard must not report a
    // change it has already recorded, or every persist would rewrite the ledger.
    const second = planLedgerEntry(state, first.brackets);
    expect(second.entry).toBeNull();
  });
});

describe("a refused ledger write is reported", () => {
  test("a corrupt record returns a refusal, not a quiet success", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    // `forkId` disagrees with its key: the tree cannot be read as a ledger.
    state.brackets.forks.a = { forkId: "not-a" };
    markRecordDirty(state.brackets, "a");

    const plan = planLedgerEntry(state, base.brackets);
    expect(plan.entry).toBeNull();
    expect(plan.refused).toBeDefined();
    // The journal is untouched, so a reload still sees the last good history.
    expect(plan.brackets).toBe(base.brackets);
  });

  test("an unreadable tree with no baseline is refused too", () => {
    const state = freshState();
    state.brackets.forks.bad = { forkId: "bad" };
    const plan = planLedgerEntry(state, null);
    expect(plan.entry).toBeNull();
    expect(plan.refused).toBeDefined();
  });

  test("the anchor reports the refusal as a failed persist", () => {
    let leafId = "base";
    let serial = 0;
    const entries = new Map([["base", { id: "base", parentId: null }]]);
    const manager = {
      getLeafId: () => leafId,
      getLeafEntry: () => entries.get(leafId),
      getBranch: () => {
        const chain = [];
        let cursor = leafId;
        while (cursor) {
          const entry = entries.get(cursor);
          if (!entry) break;
          chain.push(entry);
          cursor = entry.parentId;
        }
        return chain.reverse();
      },
      appendCustomEntry: (type, data) => {
        const id = `e${++serial}`;
        entries.set(id, { id, parentId: leafId, type: "custom", customType: type, data });
        leafId = id;
        return id;
      },
    };

    const state = freshState();
    const errors = [];
    const anchor = createPersistenceAnchor({
      manager,
      state: () => state,
      initialState: null,
      initialEntryId: null,
      serialize: serializeStateShared,
      plan: planStateEntry,
      planLedger: planLedgerEntry,
      split: splitState,
      type: "scope.state",
      noteError: (where, error) => errors.push({ where, error: String(error) }),
    });

    register(state, "a");
    expect(anchor.persist()).toBe(true);

    // Corrupt the live tree the way a bad caller could.
    state.brackets.forks.a = { forkId: "mismatch" };
    markRecordDirty(state.brackets, "a");

    expect(anchor.persist()).toBe(false);
    expect(errors.length).toBe(1);
    expect(errors[0].where).toBe("ledger");
    expect(errors[0].error).toContain("refused");
  });
});
