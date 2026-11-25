// What the journal owes is a set, not a comparison.
//
// `dirtyForks` is the serializer's scratch list and is cleared every time a
// snapshot is built. Using it to answer "what is still unwritten" worked only
// while the write succeeded: after a failed append the mark was already
// consumed, and the retry had to rebuild the answer by walking snapshot steps,
// which a trimmed window breaks. The unsettled set answers that question and is
// cleared in exactly one place — after the host accepts a write.

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

// An entry names a changed record in `patches` and a record with no predecessor
// in `set`; the records it names are the two sets together.
const recordsNamed = (entry) => ({ ...(entry?.set ?? {}), ...(entry?.patches ?? {}) });

describe("the unsettled set", () => {
  test("a moved record is owed until a write is accepted", () => {
    const state = freshState();
    registerLedger(state.brackets);
    register(state, "a");
    const base = planLedgerEntry(state, null);
    expect(base.entry.full).toBe(true);

    // Registration owes both the new record and the structural change; planning
    // does not settle either before a write is accepted.
    const owed = ledgerPending(state.brackets);
    expect(owed.struct).toBe(true);
    expect(owed.records).toEqual(["a"]);

    state.brackets.forks.a.task = "edited";
    markRecordDirty(state.brackets, "a");
    expect(ledgerPending(state.brackets).records).toEqual(["a"]);

    commitPersisted(state.brackets);
    expect(ledgerPending(state.brackets).records).toEqual([]);
    expect(ledgerPending(state.brackets).struct).toBe(false);
  });

  test("a failed append keeps the debt, so the retry owes the same record", () => {
    const { manager, written } = journal();
    const state = freshState();
    registerLedger(state.brackets);
    const { anchor, errors } = anchorFor(manager, state);

    register(state, "a");
    expect(anchor.persist()).toBe(true);
    const afterFirst = written.length;

    state.brackets.forks.a.task = "first attempt";
    markRecordDirty(state.brackets, "a");
    manager.failNext();
    expect(anchor.persist()).toBe(false);
    expect(errors.length).toBe(1);
    // Nothing landed, so the record is still owed.
    expect(ledgerPending(state.brackets).records).toEqual(["a"]);

    expect(anchor.persist()).toBe(true);
    expect(written.length).toBe(afterFirst + 1);
    const ledgerHalf = written.at(-1).ledger ?? written.at(-1);
    expect(Object.keys(recordsNamed(ledgerHalf))).toEqual(["a"]);
    expect(ledgerHalf.patches.a).toBeArray();
    // The retry owes the same record, and the value it carries is the one the
    // write failed to deliver.
    expect(JSON.stringify(ledgerHalf.patches.a)).toContain("first attempt");
  });
});

describe("a write that only moved record contents", () => {
  test("the entry names those records and nothing else", () => {
    const state = freshState();
    registerLedger(state.brackets);
    register(state, "a");
    register(state, "b");
    const base = planLedgerEntry(state, null);
    commitPersisted(state.brackets);

    state.brackets.forks.b.task = "only b moved";
    markRecordDirty(state.brackets, "b");
    const next = planLedgerEntry(state, base.brackets);

    expect(Object.keys(recordsNamed(next.entry))).toEqual(["b"]);
    expect(next.entry.head).toBeNull();
    expect(next.refused).toBeUndefined();

    const folded = foldStateChain([base.entry, next.entry]);
    expect(Object.keys(folded.brackets.forks).sort()).toEqual(["a", "b"]);
    expect(folded.brackets.forks.b.task).toBe("only b moved");
    expect(folded.brackets.forks.a.task).toBeUndefined();
  });

  test("an invalid record on the cheap path is still refused", () => {
    const state = freshState();
    registerLedger(state.brackets);
    register(state, "a");
    const base = planLedgerEntry(state, null);
    commitPersisted(state.brackets);

    // A record that fails `validRecord`, marked as moved so the cheap path
    // reads it. The refusal must be explicit, not a quiet "nothing owed".
    state.brackets.forks.a = { forkId: "mismatch" };
    markRecordDirty(state.brackets, "a");
    const plan = planLedgerEntry(state, base.brackets);

    expect(plan.entry).toBeNull();
    // The tree is still addressable, so the shape check passes; the record is
    // what cannot be read. Naming that case separately from a broken mirror is
    // what lets a reader tell "my container bookkeeping is wrong" apart from
    // "this one record is corrupt".
    expect(plan.refused).toBe("unreadable-ledger");
    expect(plan.brackets).toBe(base.brackets);
  });

  test("a container change goes back to the full check", () => {
    const state = freshState();
    registerLedger(state.brackets);
    register(state, "a");
    const base = planLedgerEntry(state, null);
    commitPersisted(state.brackets);

    // Same length, same identity, different contents. No constant reading can
    // see this, so the contract is that a container change is *marked*: with
    // the mark the write goes back to the full check, which sees the broken
    // mirror and refuses. Without the mark the cheap path cannot tell, and that
    // gap is stated rather than papered over.
    state.brackets.order[0] = "ghost";
    markLedgerStructDirty(state.brackets);
    const plan = planLedgerEntry(state, base.brackets);
    expect(plan.refused).toBe("invalid-ledger");
  });

  test("a marked removal keeps the header it needs", () => {
    const state = freshState();
    registerLedger(state.brackets);
    register(state, "a");
    register(state, "b");
    const base = planLedgerEntry(state, null);
    commitPersisted(state.brackets);

    delete state.brackets.forks.b;
    state.brackets.order = state.brackets.order.filter((id) => id !== "b");
    markLedgerStructDirty(state.brackets);

    const plan = planLedgerEntry(state, base.brackets);
    expect(plan.refused).toBeUndefined();
    expect(plan.entry.del).toEqual(["b"]);
    const folded = foldStateChain([base.entry, plan.entry].filter(Boolean));
    expect(Object.keys(folded.brackets.forks)).toEqual(["a"]);
    expect(folded.brackets.order).toEqual(["a"]);
  });
});
