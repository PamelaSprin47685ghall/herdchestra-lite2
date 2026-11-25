// Two things a ledger-only write must not disturb: the state anchor, and the
// restore path across a format boundary.
//
// A write can owe the ledger alone — one fork's text moved, the core state did
// not. That write lands an entry holding fork records and no serialized state.
// Naming it as the anchor makes the next ancestry check prove the wrong thing:
// that the ledger entry is reachable, not that the baseline a delta subtracts
// from is. The difference is observable when the branch is later cut between
// the two: the check then answers "the anchor is gone" for a baseline that is
// still there, and the session pays for a fresh checkpoint it did not need.

import { describe, expect, test } from "bun:test";

import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";
import { restoreState, persistedBaseId, hasPersistedBase } from "../src/station/restore.mjs";
import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  planStateEntry,
  splitState,
  serializeState,
  serializeStateShared,
  foldStateChain,
  deserializeState,
  isLedgerEntry,
  markRecordDirty,
  markLedgerStructDirty,
} from "../src/scope/index.mjs";

const TYPE = "scope.state";

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

/** A host tree whose leaf can be cut back, as a fold would leave it. */
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
      written.push({ id, data });
      return id;
    },
    /** Leave `id` as the leaf, dropping everything after it — a fold. */
    foldTo: (id) => {
      expect(entries.has(id)).toBe(true);
      leafId = id;
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
    type: TYPE,
    noteError: (where, error) => errors.push({ where, error: String(error) }),
  });
  return { anchor, errors };
}

describe("a ledger-only write", () => {
  test("lands fork records and leaves the state anchor on the state entry", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor, errors } = anchorFor(manager, state);

    register(state, "a");
    expect(anchor.persist()).toBe(true);
    const checkpointId = written.at(-1).id;
    expect(written.at(-1).data.kind).toBe("checkpoint");

    // Only the record's text moves: the core state is untouched, so this write
    // owes the ledger and nothing else.
    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);
    const ledgerOnly = written.at(-1);
    expect(isLedgerEntry(ledgerOnly.data)).toBe(true);
    expect(errors).toEqual([]);

    // The branch is cut back to the state entry, dropping the ledger write —
    // exactly the shape a fold leaves. The baseline is still on the branch, so
    // the next write must continue from it.
    manager.foldTo(checkpointId);
    state.brackets.forks.a.task = "a, edited again";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);
    // A delta, not a checkpoint: the anchor survived the cut.
    expect(written.at(-1).data.kind).not.toBe("checkpoint");
    expect(errors).toEqual([]);
  });

  test("a fold that removes the state entry does force a checkpoint", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    expect(anchor.persist()).toBe(true);
    const checkpointId = written.at(-1).id;

    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);

    // Cut below the state entry: the baseline is genuinely gone.
    manager.foldTo("base");
    state.brackets.forks.a.task = "after the cut";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);
    expect(written.at(-1).data.kind).toBe("checkpoint");
    // And the checkpoint carries the live ledger, so the fork history survives.
    const folded = foldStateChain(written.filter((item) => item.id !== checkpointId).map((item) => item.data));
    if (folded) expect(folded.brackets.forks.a.task).toBe("after the cut");
  });

  test("the journal still restores after a ledger-only write", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    expect(anchor.persist()).toBe(true);
    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);
    register(state, "b");
    expect(anchor.persist()).toBe(true);

    const restored = restoreState(manager);
    expect(restored.brackets.forks.a.task).toBe("a, edited");
    expect(restored.brackets.forks.b).toBeDefined();
    expect(restored.brackets.order.slice().sort()).toEqual(["a", "b"]);
  });
});

describe("a version-2 session crossed by version-3 writes", () => {
  test("the old checkpoint's ledger is replaced by the new baseline, not merged", () => {
    // A session written by the previous format: one checkpoint carrying forks.
    const legacyState = freshState();
    register(legacyState, "old");
    legacyState.seq = 3;
    const legacyEntry = {
      version: 2,
      kind: "checkpoint",
      state: serializeState(legacyState),
    };
    // What the loader saw before this process started.
    expect(isLedgerEntry(legacyEntry)).toBe(false);

    // The upgrade's first ledger write is a replacement baseline, because this
    // process has no previous snapshot to subtract from.
    const liveState = freshState();
    register(liveState, "kept");
    liveState.seq = 9;
    markLedgerStructDirty(liveState.brackets);
    const baseline = planLedgerEntry(liveState, null);
    expect(baseline.entry.full).toBe(true);

    const folded = foldStateChain([legacyEntry, baseline.entry]);
    const restored = deserializeState(folded);
    // The baseline wins whole: the v2 records are not overlaid with it, so a
    // fork this process never knew about does not come back.
    expect(restored.brackets.forks.old).toBeUndefined();
    expect(Object.keys(restored.brackets.forks)).toEqual(["kept"]);
    expect(restored.brackets.order).toEqual(["kept"]);
    expect(restored.seq).toBe(3);
  });

  test("a v2 session with no v3 ledger write keeps the ledger inside its checkpoint", () => {
    const legacyState = freshState();
    register(legacyState, "only");
    legacyState.seq = 5;
    const legacyEntry = {
      version: 2,
      kind: "checkpoint",
      state: serializeState(legacyState),
    };

    // No ledger entry at all: the folded tree must keep the checkpoint's own.
    const folded = foldStateChain([legacyEntry]);
    const restored = deserializeState(folded);
    expect(Object.keys(restored.brackets.forks)).toEqual(["only"]);
    expect(restored.seq).toBe(5);
  });

  test("restore over a v2 checkpoint and v3 writes agrees with a direct fold", () => {
    const { manager } = journal();
    const state = freshState();
    state.brackets = createBracketLedger();
    register(state, "a");
    state.seq = 1;

    // Seed the journal with a genuine version-2 checkpoint.
    manager.appendCustomEntry(TYPE, {
      version: 2,
      kind: "checkpoint",
      state: serializeState(state),
    });
    const seededId = manager.getLeafId();
    expect(persistedBaseId(manager)).toBe(seededId);
    expect(hasPersistedBase(manager)).toBe(true);

    // Then the live anchor writes v3 entries on top of it.
    const { anchor, errors } = anchorFor(manager, state);
    expect(anchor.persist()).toBe(true);
    register(state, "b");
    expect(anchor.persist()).toBe(true);
    expect(errors).toEqual([]);

    const restored = restoreState(manager);
    expect(Object.keys(restored.brackets.forks).sort()).toEqual(["a", "b"]);
    expect(restored.brackets.order.slice().sort()).toEqual(["a", "b"]);
    // The anchor named a state entry, not the ledger half of a write.
    expect(isLedgerEntry(
      manager.getBranch().find((entry) => entry.id === persistedBaseId(manager))?.data,
    )).toBe(false);
  });
});
