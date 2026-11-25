// A fold can strand the ledger snapshot while leaving the state anchor intact.
//
// `lastBrackets` is what the next ledger delta subtracts from, and it comes
// from whichever entry last carried ledger bytes — not necessarily the anchor.
// A write that owes the ledger alone (one fork's text moved, the core state did
// not) lands its own entry and advances that snapshot while the state anchor
// stays put. If the branch is then cut back to the anchor, the ledger entry is
// gone and the snapshot describes a change the journal no longer has.
//
// The failure is silent, which is why it needs a test rather than a review: the
// next delta subtracts against a snapshot that already contains the lost
// change, so the change is omitted from the entry; every container still
// matches, every remaining record still matches, and only the discarded
// record's content is stale. A reload then shows the old text.

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
  serializeStateCore,
  foldStateChain,
  deserializeState,
  validLedger,
  markRecordDirty,
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

function anchorFor(manager, state, serialize = serializeStateShared) {
  const errors = [];
  const anchor = createPersistenceAnchor({
    manager,
    state: () => state,
    initialState: null,
    initialEntryId: null,
    serialize,
    plan: planStateEntry,
    planLedger: planLedgerEntry,
    split: splitState,
    type: TYPE,
    noteError: (where, error) => errors.push({ where, error: String(error) }),
  });
  return { anchor, errors };
}

/**
 * What a reload reads: the branch's scope-state entries, oldest first.
 * This is the same collection the restore path performs.
 */
function reload(manager) {
  const payloads = manager
    .getBranch()
    .filter((entry) => entry?.type === "custom" && entry.customType === TYPE)
    .map((entry) => entry.data);
  const folded = foldStateChain(payloads);
  return folded === null ? null : deserializeState(folded);
}

describe("independent persistence anchors sharing one ledger", () => {
  test("a lagging journal retains edits accepted by another journal", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const one = journal();
    const two = journal();
    const first = anchorFor(one.manager, state, serializeStateCore);
    const second = anchorFor(two.manager, state, serializeStateCore);
    expect(first.anchor.persist()).toBe(true);
    expect(second.anchor.persist()).toBe(true);
    state.brackets.forks.a.task = "first edit";
    markRecordDirty(state.brackets, "a");
    expect(first.anchor.persist()).toBe(true);
    state.brackets.forks.b.task = "second edit";
    markRecordDirty(state.brackets, "b");
    expect(first.anchor.persist()).toBe(true);
    expect(second.anchor.persist()).toBe(true);
    const restored = reload(two.manager);
    expect(restored.brackets.forks.a.task).toBe("first edit");
    expect(restored.brackets.forks.b.task).toBe("second edit");
  });

  test("each journal retains both edits across failure and a branch cut", () => {
    const state = freshState();
    register(state, "a");
    register(state, "b");
    const one = journal();
    const two = journal();
    const first = anchorFor(one.manager, state, serializeStateCore);
    const second = anchorFor(two.manager, state, serializeStateCore);
    expect(first.anchor.persist()).toBe(true);
    expect(second.anchor.persist()).toBe(true);
    const firstBase = one.written.at(-1).id;

    state.brackets.forks.a.task = "edited a";
    markRecordDirty(state.brackets, "a");
    expect(first.anchor.persist()).toBe(true);
    let failed = false;
    const append = two.manager.appendCustomEntry;
    two.manager.appendCustomEntry = (type, data) => {
      if (!failed) { failed = true; throw new Error("write failed"); }
      return append(type, data);
    };
    expect(second.anchor.persist()).toBe(false);
    expect(second.anchor.persist()).toBe(true);

    state.brackets.forks.b.task = "edited b";
    markRecordDirty(state.brackets, "b");
    expect(first.anchor.persist()).toBe(true);
    expect(second.anchor.persist()).toBe(true);
    for (const target of [one.manager, two.manager]) {
      const restored = reload(target);
      expect(restored.brackets.forks.a.task).toBe("edited a");
      expect(restored.brackets.forks.b.task).toBe("edited b");
    }

    one.manager.foldTo(firstBase);
    expect(first.anchor.persist()).toBe(true);
    const rebased = reload(one.manager);
    expect(rebased.brackets.forks.a.task).toBe("edited a");
    expect(rebased.brackets.forks.b.task).toBe("edited b");
    expect(reload(two.manager).brackets.forks.a.task).toBe("edited a");
  });
});

describe("a fold that strands a ledger-only write", () => {
  test("the discarded record's change still reaches the journal", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor, errors } = anchorFor(manager, state);

    // Baseline: two forks, both written in one entry. A checkpoint is owed
    // because no previous state exists, so the entry also carries the ledger.
    register(state, "a");
    register(state, "b");
    expect(anchor.persist()).toBe(true);
    const checkpointId = written.at(-1).id;
    expect(written.at(-1).data.kind).toBe("checkpoint");
    expect(written.at(-1).data.ledger).toBeDefined();
    expect(errors).toEqual([]);

    // Only `a`'s text moves. The core state is unchanged, so this write owes
    // the ledger alone and lands an entry with no serialized state.
    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);
    const ledgerOnly = written.at(-1);
    expect(ledgerOnly.data.kind).toBe("ledger");
    // A changed record travels in `patches`; a record with no predecessor
    // travels in `set`. The records this entry names are the two together.
    expect(Object.keys({ ...ledgerOnly.data.set, ...(ledgerOnly.data.patches ?? {}) })).toEqual(["a"]);
    expect(errors).toEqual([]);

    // The branch is cut back to the checkpoint, dropping that ledger write.
    // `a`'s edit is now in the live tree and in no entry.
    manager.foldTo(checkpointId);

    // Another fork moves, which is what forces the next ledger write.
    state.brackets.forks.b.task = "b, edited";
    markRecordDirty(state.brackets, "b");
    expect(anchor.persist()).toBe(true);
    expect(errors).toEqual([]);

    const restored = reload(manager);
    expect(restored).not.toBeNull();
    expect(validLedger(restored.brackets)).toBe(true);
    // Both edits are in the journal, not just the one that triggered the write.
    expect(restored.brackets.forks.a.task).toBe("a, edited");
    expect(restored.brackets.forks.b.task).toBe("b, edited");
    expect(restored.brackets.order.slice().sort()).toEqual(["a", "b"]);
  });

  test("the repair is a full baseline, so nothing stale is resurrected", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    register(state, "gone");
    expect(anchor.persist()).toBe(true);
    const checkpointId = written.at(-1).id;

    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);

    // The fork is removed and the branch cut back, so the checkpoint still
    // names it while the live tree does not.
    delete state.brackets.forks.gone;
    state.brackets.order = state.brackets.order.filter((id) => id !== "gone");
    state.brackets.levels = Object.fromEntries(
      Object.entries(state.brackets.levels).map(([key, list]) => [
        key,
        list.filter((id) => id !== "gone"),
      ]),
    );
    manager.foldTo(checkpointId);
    state.brackets.forks.a.task = "a, edited again";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);

    const restored = reload(manager);
    // The baseline replaces the ledger tree, so a fork this branch no longer
    // has does not come back from the older checkpoint.
    expect(Object.keys(restored.brackets.forks)).toEqual(["a"]);
    expect(restored.brackets.order).toEqual(["a"]);
    expect(restored.brackets.forks.a.task).toBe("a, edited again");
  });

  test("a fold to the leaf leaves the incremental path intact", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    register(state, "b");
    expect(anchor.persist()).toBe(true);

    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);
    const ledgerOnlyId = written.at(-1).id;

    // Nothing is cut: the ledger entry is still the leaf, so both snapshots
    // are valid and the next write stays incremental.
    state.brackets.forks.b.task = "b, edited";
    markRecordDirty(state.brackets, "b");
    expect(anchor.persist()).toBe(true);
    const next = written.at(-1).data;
    // Only the record that moved, and no restated containers: the snapshot it
    // subtracts from is still on the branch.
    expect(next.set ? Object.keys({ ...next.set, ...(next.patches ?? {}) }) : []).toEqual(["b"]);
    expect(next.head).toBeNull();
    expect(next.full).toBeUndefined();

    const restored = reload(manager);
    expect(restored.brackets.forks.a.task).toBe("a, edited");
    expect(restored.brackets.forks.b.task).toBe("b, edited");
    expect(ledgerOnlyId).not.toBe(written.at(-1).id);
  });

  test("a cut that removes the state anchor still rebases everything", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    expect(anchor.persist()).toBe(true);

    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);

    // Cut below the checkpoint: both the state baseline and every ledger entry
    // after it are gone.
    manager.foldTo("base");
    state.brackets.forks.a.task = "after the cut";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);
    expect(written.at(-1).data.kind).toBe("checkpoint");

    const restored = reload(manager);
    expect(restored.brackets.forks.a.task).toBe("after the cut");
    expect(validLedger(restored.brackets)).toBe(true);
  });
});
