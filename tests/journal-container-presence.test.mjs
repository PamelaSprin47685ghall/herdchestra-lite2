// A key that appears with an empty list is a change, and the journal must name
// it.
//
// `arrayOps(undefined, [])` has nothing to add and nothing to remove, so the
// edit was reported as "no change" and the owner was never written. After a
// restart the live ledger had a `queues`/`levels` owner whose list was empty,
// while the restored one simply lacked the key — a state divergence the
// incremental form introduced, and one that turns a later `levels[key].push()`
// into a crash rather than a queue.

import { describe, expect, test } from "bun:test";

import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  splitState,
  serializeState,
  serializeStateShared,
  serializeLedgerShared,
  foldStateChain,
  deserializeState,
} from "../src/scope/index.mjs";
import { markLedgerStructDirty } from "../src/scope/ledger-cache.mjs";

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

/** The fields the ledger journal owns, compared structurally. */
function shape(ledger) {
  return { order: ledger.order, queues: ledger.queues, levels: ledger.levels };
}

describe("a key that appears with an empty list", () => {
  test("an empty level is named by the entry that creates it", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    const levels = state.brackets.levels;
    const key = "9";
    expect(Object.hasOwn(levels, key)).toBe(false);
    state.brackets.levels = { ...levels, [key]: [] };
    markLedgerStructDirty(state.brackets);

    const next = planLedgerEntry(state, base.brackets);
    // Nothing was added to a list and nothing removed, yet the tree moved: a
    // new owner exists. An entry that stays silent here loses it on reload.
    expect(next.entry, "a new empty level must be written").toBeTruthy();
    expect(next.entry.levelsOps?.owners?.[key]).toBeDefined();

    const folded = foldStateChain([base.entry, next.entry]);
    expect(Object.hasOwn(folded.brackets.levels, key)).toBe(true);
    expect(folded.brackets.levels[key]).toEqual([]);
  });

  test("an empty queue owner is named by the entry that creates it", () => {
    const state = freshState();
    register(state, "a");
    const base = planLedgerEntry(state, null);

    state.brackets.queues = { ...state.brackets.queues, worker: [] };
    markLedgerStructDirty(state.brackets);

    const next = planLedgerEntry(state, base.brackets);
    expect(next.entry, "a new empty queue must be written").toBeTruthy();
    expect(next.entry.queuesOps?.owners?.worker).toBeDefined();

    const folded = foldStateChain([base.entry, next.entry]);
    expect(Object.hasOwn(folded.brackets.queues, "worker")).toBe(true);
    expect(folded.brackets.queues.worker).toEqual([]);
  });

  test("a level that empties keeps its key; one that disappears loses it", () => {
    const state = freshState();
    register(state, "a");
    state.brackets.levels = { 0: ["a"], 1: [] };
    markLedgerStructDirty(state.brackets);
    const base = planLedgerEntry(state, null);

    // 0 -> [] keeps the key, 1 -> gone removes it.
    state.brackets.levels = { 0: [] };
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    const folded = foldStateChain([base.entry, next.entry]);
    expect(folded.brackets.levels).toEqual({ 0: [] });
    expect(Object.hasOwn(folded.brackets.levels, "1")).toBe(false);
  });
});

describe("a replayed journal matches the live ledger", () => {
  test("baseline, appearances, edits and removals fold to the same tree", () => {
    const state = freshState();
    const entries = [];
    let previous = null;

    const commit = () => {
      const plan = planLedgerEntry(state, previous);
      if (plan.entry) entries.push(plan.entry);
      previous = plan.brackets;
      return plan.entry;
    };

    register(state, "a");
    commit();

    // A new empty owner of each map, then real work in one of them.
    state.brackets.levels = { ...state.brackets.levels, 3: [] };
    state.brackets.queues = { ...state.brackets.queues, w: [] };
    markLedgerStructDirty(state.brackets);
    commit();

    register(state, "b");
    state.brackets.levels[3] = ["b"];
    markLedgerStructDirty(state.brackets);
    commit();

    delete state.brackets.forks.a;
    state.brackets.order = state.brackets.order.filter((id) => id !== "a");
    state.brackets.levels = Object.fromEntries(
      Object.entries(state.brackets.levels).map(([key, list]) => [
        key,
        list.filter((id) => id !== "a"),
      ]),
    );
    markLedgerStructDirty(state.brackets);
    commit();

    register(state, "c");
    state.brackets.queues.w = ["c"];
    markLedgerStructDirty(state.brackets);
    commit();

    const folded = foldStateChain(entries);
    const live = serializeLedgerShared(state.brackets);
    // What the journal owns: the folded tree must be the tree the live ledger
    // holds, container fields included.
    expect(shape(folded.brackets)).toEqual(shape(live));
    // What restore owns: it deliberately re-derives the containers from record
    // status — `levels` keeps only joined records, `queues` is rebuilt from the
    // ready ones. So comparing a restored ledger against the live ledger's raw
    // containers would compare a derived value with an input. The question the
    // journal must answer is whether the same input survives: the folded journal
    // and the live state must restore to the same ledger.
    const fromJournal = foldStateChain([
      { version: 3, kind: "checkpoint", state: serializeState(state) },
      ...entries,
    ]);
    expect(shape(deserializeState(fromJournal).brackets)).toEqual(
      shape(deserializeState(serializeState(state)).brackets),
    );
  });

  test("an entry from the old shape, with the lists in the head, still folds", () => {
    const state = freshState();
    register(state, "a");
    state.brackets.levels = { 0: ["a"] };
    state.brackets.queues = { root: ["a"] };
    markLedgerStructDirty(state.brackets);

    const live = serializeLedgerShared(state.brackets);
    const legacy = {
      version: 3,
      kind: "ledger",
      full: true,
      set: Object.fromEntries(
        Object.keys(live.forks).map((forkId) => [forkId, live.forks[forkId]]),
      ),
      del: [],
      // The pre-split shape carried order/queues/levels inside the head.
      head: {
        version: live.version,
        seq: live.seq,
        closedSeq: live.closedSeq,
        receiveSeq: live.receiveSeq,
        order: live.order,
        queues: live.queues,
        levels: live.levels,
        rootInbox: live.rootInbox,
        totals: live.totals,
      },
    };

    const folded = foldStateChain([legacy]);
    // The old shape must fold into exactly the tree the live ledger holds.
    expect(shape(folded.brackets)).toEqual(shape(live));
    // Same rule as above: restore re-derives `levels`/`queues` from record
    // status, so the journal is correct when it restores to the same ledger the
    // live state restores to — not when its raw containers equal the input.
    const withState = foldStateChain([
      { version: 3, kind: "checkpoint", state: serializeState(state) },
      legacy,
    ]);
    expect(shape(deserializeState(withState).brackets)).toEqual(
      shape(deserializeState(serializeState(state)).brackets),
    );
  });

  test("the split still keeps the ledger out of the state", () => {
    const state = freshState();
    register(state, "a");
    state.seq = 5;
    const { core, brackets } = splitState(serializeStateShared(state));
    expect(Object.hasOwn(core, "brackets")).toBe(false);
    expect(brackets.order).toEqual(["a"]);
  });
});
