// A same-length edit of a container is invisible to every cheap reading, and
// the tree it leaves must still never be stored.
//
// `order`, `queues` and `levels` are mutated in place and shared between the
// live tree and the last stored snapshot, so `order[0] = "other"` keeps both
// the array identity and its length. A validation gate keyed on "the structure
// did not move" therefore answered "nothing owed" while the live tree no longer
// agreed with its own records. The loader refuses such a tree, so storing it
// would discard the session's whole fork history on the next start — the write
// must be refused now, and the caller must be able to see that it was.

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

function journal() {
  let leafId = "base";
  let serial = 0;
  const entries = new Map([["base", { id: "base", parentId: null }]]);
  const written = [];
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
      written.push(data);
      return id;
    },
  };
  return { manager, written };
}

describe("a same-length container edit under the old gate", () => {
  test("an order id with no record is refused instead of stored", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    // The baseline is the write that establishes the durable snapshot.
    const base = planLedgerEntry(state, null);
    expect(base.entry.full).toBe(true);

    // Identity and length are unchanged; only the contents moved. Without the
    // unconditional check this write answered "nothing owed".
    const order = state.brackets.order;
    order[0] = "ghost";
    expect(order.length).toBe(2);

    const plan = planLedgerEntry(state, base.brackets);
    expect(plan.entry).toBeNull();
    expect(plan.refused).toBe("invalid-ledger");
    // The journal keeps the last readable state: the stored snapshot is what a
    // reload would read, and it still names both forks.
    expect(plan.brackets).toBe(base.brackets);
    const folded = foldStateChain([base.entry]);
    expect(Object.keys(folded.brackets.forks).sort()).toEqual(["a", "b"]);
  });

  test("a duplicated order id is refused", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const base = planLedgerEntry(state, null);

    const order = state.brackets.order;
    order[0] = order[1];
    expect(order.length).toBe(2);

    const plan = planLedgerEntry(state, base.brackets);
    expect(plan.refused).toBe("invalid-ledger");
    expect(plan.entry).toBeNull();
  });

  test("a record mutated behind its key is refused", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    state.brackets.forks.a.forkId = "renamed";
    markRecordDirty(state.brackets, "a");

    const plan = planLedgerEntry(state, base.brackets);
    // The shape is intact — `order` and `forks` still agree — so the refusal
    // comes from reading the record itself, which is what `unreadable-ledger`
    // names. The two codes are distinct on purpose: `invalid-ledger` means the
    // tree cannot be addressed (a broken mirror, a duplicate id), while this one
    // means the tree is addressable but a record inside it cannot be restored.
    expect(plan.refused).toBe("unreadable-ledger");
    expect(plan.entry).toBeNull();
    expect(plan.brackets).toBe(base.brackets);
  });

  test("the refusal reaches the anchor as a failed persist", () => {
    const { manager, written } = journal();
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
    register(state, "b");
    expect(anchor.persist()).toBe(true);
    const before = written.length;

    state.brackets.order[0] = "ghost";
    expect(anchor.persist()).toBe(false);
    expect(written.length).toBe(before);
    expect(errors.length).toBe(1);
    expect(errors[0].where).toBe("ledger");
    expect(errors[0].error).toContain("invalid-ledger");
  });
});

describe("the valid paths still write", () => {
  test("a marked removal is written and stays readable", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const base = planLedgerEntry(state, null);

    delete state.brackets.forks.b;
    state.brackets.order = state.brackets.order.filter((id) => id !== "b");
    state.brackets.levels = Object.fromEntries(
      Object.entries(state.brackets.levels).map(([key, list]) => [
        key,
        list.filter((id) => id !== "b"),
      ]),
    );
    markRecordDirty(state.brackets, "b");

    const plan = planLedgerEntry(state, base.brackets);
    expect(plan.refused).toBeUndefined();
    expect(plan.entry).toBeTruthy();
    const folded = foldStateChain([base.entry, plan.entry].filter(Boolean));
    expect(Object.keys(folded.brackets.forks)).toEqual(["a"]);
    expect(folded.brackets.order).toEqual(["a"]);
  });

  test("a quiet valid tree owes nothing", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);
    const quiet = planLedgerEntry(state, base.brackets);
    expect(quiet.refused).toBeUndefined();
    expect(quiet.entry).toBeNull();
  });
});
