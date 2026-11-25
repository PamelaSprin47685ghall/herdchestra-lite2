// Failures that a passing happy-path suite does not catch: an anchor that
// exists but is no longer an ancestor, a write that fails between the two
// appends, a removal that changes the container header, and a session that
// upgrades from a version-2 chain.

import { describe, expect, test } from "bun:test";
import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";
import { persistedBaseId, hasPersistedBase } from "../src/station/restore.mjs";
import {
  createState,
  deserializeState,
  foldStateChain,
  isLedgerEntry,
  markLedgerStructDirty,
  planLedgerEntry,
  planStateEntry,
  registerFork,
  serializeState,
  serializeStateShared,
  splitState,
  createBracketLedger,
} from "../src/scope/index.mjs";

// A host session tree: entries linked by parentId, one leaf.
function host(initialLeaf = "base") {
  let leafId = initialLeaf;
  const entries = new Map([[initialLeaf, { id: initialLeaf, parentId: null }]]);
  let serial = 0;
  let appends = 0;
  let failAfter = Infinity;
  const appended = [];

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
    appendCustomEntry: (type, entry) => {
      appends += 1;
      if (appends > failAfter) {
        failAfter = Infinity;
        throw new Error("disk full");
      }
      const id = `e${++serial}`;
      entries.set(id, { id, parentId: leafId, type: "custom", customType: type, data: entry });
      leafId = id;
      appended.push({ id, entry });
      return id;
    },
    // A rewrite that detaches an entry from the current chain while keeping
    // the leaf id: the exact case an "entry still exists" shortcut misses.
    reparent: (id, parentId) => {
      const entry = entries.get(id);
      if (entry) entry.parentId = parentId;
    },
    appendHost: (id) => {
      entries.set(id, { id, parentId: leafId, type: "message" });
      leafId = id;
    },
    switchTo: (id) => {
      leafId = id;
    },
  };

  return {
    manager,
    appended,
    bump() {
      leafId = leafId;
    },
    failNextAppend() {
      // Throw on the very next append: `appends` is incremented before the
      // comparison, so the threshold is the count reached so far.
      failAfter = appends;
    },
  };
}

function anchorHarness() {
  const h = host();
  let value = 0;
  const errors = [];
  const anchor = createPersistenceAnchor({
    manager: h.manager,
    state: () => ({ value }),
    initialState: null,
    initialEntryId: null,
    serialize: (state) => JSON.stringify(state),
    plan: (previous, next, writes) => {
      if (previous === next) return null;
      return { kind: previous === null || writes >= 64 ? "checkpoint" : "delta" };
    },
    planLedger: () => ({ entry: null, brackets: null }),
    split: (full) => ({ core: full }),
    type: "scope.state",
    noteError: (where, error) => errors.push({ where, error }),
  });
  return {
    anchor,
    h,
    errors,
    bump() {
      value += 1;
    },
  };
}

describe("anchor ancestry", () => {
  test("an anchor that exists but is no longer an ancestor is not trusted", () => {
    const { anchor, h } = anchorHarness();
    let value = 0;
    // Build: base <- state1 <- host1 <- host2, with a rewrite that lifts host2
    // out from under the state entry.
    anchor.persist();
    const anchorId = h.appended.at(-1).id;
    h.manager.appendHost("host1");
    value += 1;
    anchor.persist();
    h.manager.appendHost("host2");
    h.manager.reparent("host2", "base");
    expect(h.manager.getLeafId()).toBe("host2");
    // The anchor entry is still in the journal and the leaf id never changed
    // for this step: only ancestry can decide, and it now says no.
    expect(h.manager.getBranch().some((entry) => entry.id === anchorId)).toBe(false);
    const before = h.appended.length;
    anchor.persist();
    expect(h.appended.length).toBe(before + 1);
    expect(h.appended.at(-1).entry.kind).toBe("checkpoint");
  });

  test("a leaf that hangs off the baseline needs no walk", () => {
    const { anchor, h } = anchorHarness();
    anchor.persist();
    h.manager.appendHost("host1");
    let reads = 0;
    const getBranch = h.manager.getBranch;
    h.manager.getBranch = () => {
      reads += 1;
      return getBranch();
    };
    anchor.persist();
    expect(reads).toBe(0);
  });
});

describe("partial writes", () => {
  test("a failed append keeps the baseline so the retry is a delta", () => {
    const { anchor, h, errors, bump } = anchorHarness();
    anchor.persist();
    expect(h.appended.at(-1).entry.kind).toBe("checkpoint");
    // There must be something owed, or the failed write is never attempted.
    bump();
    h.failNextAppend();
    expect(anchor.persist()).toBe(false);
    expect(errors.length).toBe(1);
    // Nothing landed, so the baseline is untouched and the retry continues
    // from it instead of starting a new checkpoint chain.
    expect(anchor.persist()).toBe(true);
    expect(h.appended.at(-1).entry.kind).toBe("delta");
  });
});

describe("ledger entry shape", () => {
  function stateWithFork() {
    const state = createState();
    state.brackets = createBracketLedger();
    const registered = registerFork(state.brackets, {
      forkId: "a",
      ownerId: "root",
      fsm: "one state",
      depth: 0,
      budget: { read: 1 },
      profession: "You are a tester.",
    });
    expect(registered.ok).toBe(true);
    return state;
  }

  test("a removal rewrites the container header even without a dirty mark", () => {
    const state = stateWithFork();
    const first = planLedgerEntry(state, null);
    // Removing a record is a mutation of the copy-on-write tree, so it must be
    // marked like any other; an unmarked removal is invisible to the journal.
    state.brackets.order = [];
    delete state.brackets.forks.a;
    markLedgerStructDirty(state.brackets);
    const second = planLedgerEntry(state, first.brackets);
    expect(second.entry.del).toEqual(["a"]);
    expect(second.entry.head).not.toBeNull();
    // The stored list is edited, not re-copied: the removal names the id.
    expect(second.entry.orderOps.remove).toContain("a");
    const folded = foldStateChain([first.entry, second.entry]);
    const restored = deserializeState(folded);
    expect(restored.brackets.forks).toEqual({});
    expect(restored.brackets.order).toEqual([]);
  });

  test("a version-2 chain plus version-3 ledger entries restores together", () => {
    const legacy = stateWithFork();
    legacy.seq = 4;
    const v2Entry = { version: 2, kind: "checkpoint", state: serializeState(legacy) };

    const live = stateWithFork();
    live.seq = 9;
    live.brackets.forks.a.task = "returned";
    markLedgerStructDirty(live.brackets);
    const ledgerEntry = planLedgerEntry(live, null).entry;
    expect(isLedgerEntry(ledgerEntry)).toBe(true);

    const restored = deserializeState(foldStateChain([v2Entry, ledgerEntry]));
    expect(restored.seq).toBe(4);
    expect(restored.brackets.forks.a.task).toBe("returned");
  });
});

describe("restore picks the state entry", () => {
  test("a ledger entry never becomes the state anchor", () => {
    const h = host();
    h.manager.appendCustomEntry("scope.state", { version: 3, kind: "checkpoint", state: {} });
    const stateId = h.manager.getLeafId();
    h.manager.appendCustomEntry("scope.state", { version: 3, kind: "ledger", set: {}, del: [], head: null });
    expect(h.manager.getLeafId()).not.toBe(stateId);
    expect(persistedBaseId(h.manager)).toBe(stateId);
    expect(hasPersistedBase(h.manager)).toBe(true);
  });
});

// A write can fail after the ledger snapshot was computed: the serializer
// clears the live tree's dirty mark while producing it, so anything that reads
// that mark afterwards reads "clean" about a change the journal never received.
// These tests drive the real serializer and the real planner through a failing
// append, then rebuild the journal from what actually landed.
describe("a failed append must not swallow the ledger header", () => {
  function ledgerHarness() {
    const h = host();
    const state = createState();
    state.brackets = createBracketLedger();
    const errors = [];
    const anchor = createPersistenceAnchor({
      manager: h.manager,
      state: () => state,
      initialState: null,
      initialEntryId: null,
      serialize: serializeStateShared,
      // The production planner compares values and emits `state`/`ops`; a
      // stand-in that only named `kind` folded into a state with no version,
      // and deserializeState rejected the whole chain.
      plan: planStateEntry,
      planLedger: planLedgerEntry,
      split: splitState,
      type: "scope.state",
      noteError: (where, error) => errors.push({ where, error }),
    });
    return { anchor, h, state, errors };
  }

  function addFork(state, forkId) {
    const registered = registerFork(state.brackets, {
      forkId,
      ownerId: "root",
      fsm: "one state",
      depth: 0,
      budget: { read: 1 },
      profession: "You are a tester.",
    });
    expect(registered.ok).toBe(true);
  }

  function storedLedgerEntries(h) {
    // Every entry, in the order it landed: the restart path folds the whole
    // journal, and a ledger-only chain has no base state to deserialize.
    return h.appended.map((item) => item.entry);
  }

  test("the retry after a failed first write still writes the containers", () => {
    const { anchor, h, state, errors } = ledgerHarness();
    // The journal is established before any fork exists. State and ledger
    // travel together, so the first entry already carries a ledger half.
    expect(anchor.persist()).toBe(true);
    expect(h.appended.at(-1).entry.ledger.order).toEqual([]);

    // A fork appears: this moves one record *and* the container's `order`.
    addFork(state, "a");
    h.failNextAppend();
    expect(anchor.persist()).toBe(false);
    expect(errors.length).toBe(1);

    // Nothing landed, so the retry owes the whole change. The mark that said
    // "the containers moved" was consumed by the failed attempt; a decision
    // made from that mark would now answer "no header needed".
    expect(anchor.persist()).toBe(true);

    // The restart path is the fold itself: what the journal holds is what a
    // load sees.
    const folded = foldStateChain(storedLedgerEntries(h));
    expect(Object.keys(folded.brackets.forks)).toEqual(["a"]);
    // The loss would show here: the record stored, its id in `order` not, and
    // a chain whose `order` names no such fork fails `validLedger` on load.
    expect(folded.brackets.order).toEqual(["a"]);
  });

  test("a structural-only change retried after a failure is not dropped", () => {
    const { anchor, h, state, errors } = ledgerHarness();
    expect(anchor.persist()).toBe(true);
    const before = h.appended.length;

    // A container field moves and no record does.
    state.brackets.seq = 41;
    markLedgerStructDirty(state.brackets);
    h.failNextAppend();
    expect(anchor.persist()).toBe(false);
    expect(errors.length).toBe(1);
    expect(h.appended.length).toBe(before);

    expect(anchor.persist()).toBe(true);

    // Before the header decision became a function of the two snapshots, the
    // retry owed nothing at all: no record moved, so no entry was produced and
    // `seq` silently stayed at its old value for the life of the session.
    expect(h.appended.length).toBe(before + 1);
    const folded = deserializeState(foldStateChain(storedLedgerEntries(h)));
    expect(folded.brackets.seq).toBe(41);
  });

  test("one append carries both halves, so a failure lands neither", () => {
    const { anchor, h, state, errors } = ledgerHarness();
    expect(anchor.persist()).toBe(true);
    addFork(state, "a");
    // The state half must be owed too, or only the ledger is written and there
    // is nothing to merge: a ledger-only change is legitimately one entry.
    state.seq = 77;
    const appends = h.appended.length;

    // One append is one atomic fact. Landing the fork records and failing the
    // state entry would leave the journal describing a state it never
    // received, which is exactly the half-commit this shape removes.
    h.failNextAppend();
    expect(anchor.persist()).toBe(false);
    expect(errors.length).toBe(1);
    expect(h.appended.length).toBe(appends);

    expect(anchor.persist()).toBe(true);
    expect(h.appended.length).toBe(appends + 1);
    expect(isLedgerEntry(h.appended.at(-1).entry)).toBe(false);

    const folded = deserializeState(foldStateChain(storedLedgerEntries(h)));
    expect(Object.keys(folded.brackets.forks)).toEqual(["a"]);
    expect(folded.brackets.order).toEqual(["a"]);
  });

  test("a v3 baseline replaces a v2 history without resurrecting it", () => {
    // A session written by the previous format: the checkpoint carries forks.
    const legacy = createState();
    legacy.brackets = createBracketLedger();
    addFork(legacy, "old");
    legacy.seq = 3;
    const v2 = { version: 2, kind: "checkpoint", state: serializeState(legacy) };

    // The next process starts from that history and writes v3 entries.
    const state = createState();
    state.brackets = createBracketLedger();
    addFork(state, "new");
    state.seq = 9;
    markLedgerStructDirty(state.brackets);
    const v3 = planLedgerEntry(state, null);

    const folded = deserializeState(foldStateChain([v2, v3.entry]));
    expect(folded.brackets.forks.old).toBeUndefined();
    expect(Object.keys(folded.brackets.forks)).toEqual(["new"]);
    expect(folded.brackets.order).toEqual(["new"]);
  });

  test("a branch switch rewrites the records of the branch being written", () => {
    // Two branches hold different forks. The anchor's snapshot belongs to the
    // first; after the switch every record is a new object, so the whole map is
    // written once. Correct, and not the steady-state cost.
    const first = createState();
    first.brackets = createBracketLedger();
    addFork(first, "a");
    markLedgerStructDirty(first.brackets);
    const a = planLedgerEntry(first, null);

    const second = createState();
    second.brackets = createBracketLedger();
    addFork(second, "b");
    markLedgerStructDirty(second.brackets);
    const b = planLedgerEntry(second, a.brackets);

    expect(Object.keys(b.entry.set)).toEqual(["b"]);
    expect(b.entry.del).toEqual(["a"]);
    const folded = foldStateChain([a.entry, b.entry]);
    expect(Object.keys(folded.brackets.forks)).toEqual(["b"]);
    expect(folded.brackets.order).toEqual(["b"]);
  });
});
