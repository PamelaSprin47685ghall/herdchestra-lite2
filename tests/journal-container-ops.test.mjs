// The ledger's growing lists are written as edits, not as copies.
//
// `order` and `queues` hold one entry per fork. Written whole into every ledger
// entry, a session pays Θ(F) bytes for a list that moved by one id — the head
// growth that made the journal outgrow the conversation it describes. These
// tests pin the incremental form: what a write names must be the edit, and the
// fold must rebuild the list the full form would have produced.

import { describe, expect, test } from "bun:test";

import {
  createState,
  createBracketLedger,
  registerFork,
  markLedgerStructDirty,
  planLedgerEntry,
  splitState,
  serializeStateShared,
  foldStateChain,
  deserializeState,
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

function bytes(value) {
  return JSON.stringify(value)?.length ?? 0;
}

describe("order is an edit, not a copy", () => {
  test("replaying incremental appends does not mutate journal entries", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);
    register(state, "b");
    const next = planLedgerEntry(state, base.brackets);
    const original = JSON.stringify([base.entry, next.entry]);
    const first = foldStateChain([base.entry, next.entry]);
    expect(first.brackets.order).toEqual(["a", "b"]);
    expect(JSON.stringify([base.entry, next.entry])).toBe(original);
    first.brackets.order.push("outside");
    expect(foldStateChain([base.entry, next.entry]).brackets.order).toEqual(["a", "b"]);
  });
  test("registering a fork names only that fork", () => {
    const state = freshState();
    register(state, "f0");
    const base = planLedgerEntry(state, null);
    // The baseline has nothing to subtract from, so it names the list whole.
    expect(base.entry.order).toEqual(["f0"]);
    expect(base.entry.orderOps).toBeUndefined();

    let previous = base.brackets;
    for (let index = 1; index < 40; index += 1) {
      register(state, `f${index}`);
      const plan = planLedgerEntry(state, previous);
      expect(plan.entry, `fork ${index} must be written`).toBeTruthy();
      // The whole list must not be present; only the appended id.
      expect(plan.entry.order).toBeUndefined();
      expect(plan.entry.orderOps).toEqual({ remove: [], append: [`f${index}`] });
      previous = plan.brackets;
    }
  });

  test("the written bytes stay flat as the list grows", () => {
    const state = freshState();
    register(state, "f0");
    let plan = planLedgerEntry(state, null);
    const firstBytes = bytes(plan.entry);
    let previous = plan.brackets;
    let lastBytes = 0;

    for (let index = 1; index < 200; index += 1) {
      register(state, `f${index}`);
      plan = planLedgerEntry(state, previous);
      previous = plan.brackets;
      lastBytes = bytes(plan.entry);
    }

    // 199 forks later the entry is still one id, not a 200-item list: the
    // per-write cost no longer grows with the session.
    expect(lastBytes).toBeLessThan(firstBytes + 64);
    expect(previous.order.length).toBe(200);
  });

  test("removing a fork edits the list by id", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const first = planLedgerEntry(state, null);

    delete state.brackets.forks.b;
    state.brackets.order = state.brackets.order.filter((id) => id !== "b");
    markLedgerStructDirty(state.brackets);

    const second = planLedgerEntry(state, first.brackets);
    expect(second.entry.del).toEqual(["b"]);
    expect(second.entry.orderOps).toEqual({ remove: ["b"], append: [] });
    // The head no longer needs the whole list to describe the removal.
    expect(second.entry.order).toBeUndefined();

    const restored = foldStateChain([first.entry, second.entry]);
    expect(restored.brackets.order).toEqual(["a"]);
    expect(Object.keys(restored.brackets.forks)).toEqual(["a"]);
  });

  test("a reordered list falls back to naming it whole", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const first = planLedgerEntry(state, null);

    // Not an append: the fold cannot replay this as an edit.
    state.brackets.order = ["b", "a"];
    markLedgerStructDirty(state.brackets);
    const second = planLedgerEntry(state, first.brackets);
    expect(second.entry.orderOps).toEqual({ reset: ["b", "a"] });

    const restored = foldStateChain([first.entry, second.entry]);
    expect(restored.brackets.order).toEqual(["b", "a"]);
  });

  test("a baseline after a rebase names the lists whole again", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const plan = planLedgerEntry(state, null);
    expect(plan.entry.full).toBe(true);
    expect(plan.entry.order).toEqual(["a", "b"]);
    // The fold starts from an empty tree, so the whole list is required.
    const restored = foldStateChain([plan.entry]);
    expect(restored.brackets.order).toEqual(["a", "b"]);
  });
});

describe("queues are edited per owner", () => {
  test("replay owns queue maps and never mutates earlier journal entries", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);
    state.brackets.queues = { root: ["a"], extra: [] };
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);
    state.brackets.queues = { root: [], extra: ["a"] };
    markLedgerStructDirty(state.brackets);
    const last = planLedgerEntry(state, next.brackets);
    const entries = [base.entry, next.entry, last.entry];
    const original = JSON.stringify(entries);
    const result = foldStateChain(entries);
    expect(result.brackets.queues).toEqual({ root: [], extra: ["a"] });
    expect(JSON.stringify(entries)).toBe(original);
    result.brackets.queues.extra.push("outside");
    expect(foldStateChain(entries).brackets.queues.extra).toEqual(["a"]);
  });
  test("only the owner whose list moved is named", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    state.brackets.queues = { root: ["a"], other: ["b"] };
    markLedgerStructDirty(state.brackets);
    const base = planLedgerEntry(state, null);
    expect(base.entry.queues).toEqual({ root: ["a"], other: ["b"] });

    // One owner gains an id; the other did not move and must not be named.
    state.brackets.queues = { root: ["a", "c"], other: ["b"] };
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);
    expect(next.entry.queues).toBeUndefined();
    expect(next.entry.queuesOps).toEqual({
      owners: { root: { remove: [], append: ["c"] } },
      removed: [],
    });

    const restored = foldStateChain([base.entry, next.entry]);
    expect(restored.brackets.queues).toEqual({ root: ["a", "c"], other: ["b"] });
  });

  test("an owner that disappears is removed, not rewritten", () => {
    const state = freshState();
    register(state, "a");
    state.brackets.queues = { root: ["a"], gone: ["a"] };
    markLedgerStructDirty(state.brackets);
    const base = planLedgerEntry(state, null);

    state.brackets.queues = { root: ["a"] };
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);
    expect(next.entry.queuesOps).toEqual({ owners: {}, removed: ["gone"] });

    const restored = foldStateChain([base.entry, next.entry]);
    expect(restored.brackets.queues).toEqual({ root: ["a"] });
  });
});

describe("compatibility", () => {
  test("an entry that still writes the lists whole is folded as before", () => {
    // The shape written before the lists moved into their own edits.
    const state = freshState();
    register(state, "a");
    const plan = planLedgerEntry(state, null);
    const legacy = {
      ...plan.entry,
      order: ["a"],
      queues: { root: ["a"] },
    };
    const restored = foldStateChain([legacy]);
    expect(restored.brackets.order).toEqual(["a"]);
    expect(restored.brackets.queues).toEqual({ root: ["a"] });
  });

  test("a replayed append does not duplicate an id", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);
    // The same edit landed twice: a retry, or an entry replayed after a
    // restart. The list must not grow a duplicate.
    const twice = [{ ...base.entry }, { ...base.entry }];
    const restored = foldStateChain(twice);
    expect(restored.brackets.order).toEqual(["a"]);
  });

  test("the journal still splits state from ledger and folds back", () => {
    const state = freshState();
    register(state, "a");
    state.seq = 4;
    const { core, brackets } = splitState(serializeStateShared(state));
    expect(Object.hasOwn(core, "brackets")).toBe(false);
    expect(brackets.order).toEqual(["a"]);
  });
});
