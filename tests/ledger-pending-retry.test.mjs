// What the journal owes must survive both a failed append and a structural
// change arriving in between.
//
// `unpersisted` is cleared in exactly one place — after the host accepts a
// write. The structural mark lives beside it. These two facts only mean
// something if the four combinations behave: a record edit alone, a record edit
// that also registers a fork, a failed append followed by a structural change,
// and a removal whose record was marked before it disappeared.

import { describe, expect, test } from "bun:test";

import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";
import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  planStateEntry,
  splitState,
  serializeStateShared,
  foldStateChain,
  validLedger,
  markRecordDirty,
  markLedgerStructDirty,
} from "../src/scope/index.mjs";
import {
  commitPersisted,
  ledgerPending,
  registerLedger,
} from "../src/scope/ledger-cache.mjs";

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

/** Drop a fork the way a fold or a rollback does: record, list, levels. */
function drop(state, forkId) {
  delete state.brackets.forks[forkId];
  state.brackets.order = state.brackets.order.filter((id) => id !== forkId);
  state.brackets.levels = Object.fromEntries(
    Object.entries(state.brackets.levels).map(([key, list]) => [
      key,
      list.filter((id) => id !== forkId),
    ]),
  );
  markLedgerStructDirty(state.brackets);
}

function journal() {
  let leafId = "base";
  let serial = 0;
  let failNext = false;
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
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      const id = `e${++serial}`;
      entries.set(id, { id, parentId: leafId, type: "custom", customType: type, data });
      leafId = id;
      written.push(data);
      return id;
    },
    failNext: () => {
      failNext = true;
    },
  };
  return { manager, written };
}

function anchorFor(manager, state) {
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
  return { anchor, errors };
}

/** What a reload reads, as the journal's own view of the fork tree. */
function reloaded(written) {
  const folded = foldStateChain(written);
  return folded === null ? null : folded.brackets;
}

describe("a failed append followed by a structural change", () => {
  test("the retry writes the record and the new fork together", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor, errors } = anchorFor(manager, state);

    register(state, "a");
    expect(anchor.persist()).toBe(true);

    // A record edit fails to land.
    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    manager.failNext();
    expect(anchor.persist()).toBe(false);
    expect(errors.length).toBe(1);

    // Before the retry, a fork is registered. The pending set still names only
    // "a", so the shortcut would omit "b" — which is exactly what the
    // structural mark must prevent.
    register(state, "b");
    expect(ledgerPending(state.brackets).struct).toBe(true);

    expect(anchor.persist()).toBe(true);

    const reload = reloaded(written);
    expect(reload).not.toBeNull();
    expect(validLedger(reload)).toBe(true);
    expect(Object.keys(reload.forks).sort()).toEqual(["a", "b"]);
    expect(reload.forks.a.task).toBe("a, edited");
    expect(reload.order).toEqual(["a", "b"]);
    // Nothing is owed after the accepted write: the next pass appends nothing.
    // `ledgerPending` answers for the legacy single writer, and the anchor owns
    // a row of its own, so it is not this journal and cannot answer for it.
    const accepted = written.length;
    expect(anchor.persist()).toBe(true);
    expect(written.length).toBe(accepted);
  });

  test("a removal marked only as structural still reaches the journal", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    register(state, "b");
    expect(anchor.persist()).toBe(true);

    drop(state, "b");
    expect(anchor.persist()).toBe(true);

    const reload = reloaded(written);
    expect(validLedger(reload)).toBe(true);
    expect(Object.keys(reload.forks)).toEqual(["a"]);
    expect(reload.order).toEqual(["a"]);
  });

  test("a record marked before it vanished does not resurrect it", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const base = planLedgerEntry(state, null);
    commitPersisted(state.brackets);

    // The record is marked as moved, then the fork is removed. The pending set
    // names an id that is no longer a record; the live tree decides which of
    // "moved" and "deleted" it is, so no tombstone list can disagree.
    state.brackets.forks.a.task = "about to go";
    markRecordDirty(state.brackets, "a");
    drop(state, "a");

    const plan = planLedgerEntry(state, base.brackets);
    expect(plan.refused).toBeUndefined();
    expect(Object.keys({ ...plan.entry.set, ...(plan.entry.patches ?? {}) })).toEqual([]);
    expect(plan.entry.del).toEqual(["a"]);

    const folded = foldStateChain([base.entry, plan.entry].filter(Boolean));
    expect(validLedger(folded.brackets)).toBe(true);
    expect(Object.keys(folded.brackets.forks)).toEqual(["b"]);
    expect(folded.brackets.order).toEqual(["b"]);
  });
});

describe("a record-only write after a rebuild", () => {
  test("records rebuilt with the same content are not rewritten, and content survives", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const base = planLedgerEntry(state, null);
    commitPersisted(state.brackets);

    // Rebuild every record object without changing content, as a restore does,
    // then move one record. Identity of the fork map changed but its contents
    // did not, so the unchanged records need no bytes: the stored copies mean
    // the same thing.
    state.brackets.forks = Object.fromEntries(
      Object.entries(state.brackets.forks).map(([id, record]) => [
        id,
        JSON.parse(JSON.stringify(record)),
      ]),
    );
    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");

    const plan = planLedgerEntry(state, base.brackets);
    expect(plan.refused).toBeUndefined();
    expect(Object.keys({ ...plan.entry.set, ...(plan.entry.patches ?? {}) })).toEqual(["a"]);

    const folded = foldStateChain([base.entry, plan.entry].filter(Boolean));
    expect(validLedger(folded.brackets)).toBe(true);
    expect(Object.keys(folded.brackets.forks).sort()).toEqual(["a", "b"]);
    expect(folded.brackets.forks.a.task).toBe("a, edited");
    expect(folded.brackets.forks.b.forkId).toBe("b");
  });
});
