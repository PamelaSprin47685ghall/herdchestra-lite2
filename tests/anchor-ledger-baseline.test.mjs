import { describe, expect, test } from "bun:test";

import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";
import { restoreState } from "../src/station/restore.mjs";
import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  planStateEntry,
  splitState,
  serializeStateShared,
  markRecordDirty,
  markLedgerStructDirty,
} from "../src/scope/index.mjs";

// The ledger journal used to end only at a restart: a delta is written against
// the last accepted snapshot, and that snapshot is kept until an anchor check
// drops it. Restore therefore folded every entry the branch held, so a cold
// start cost the whole session — the same unbounded growth the giant
// checkpoints used to cost, one entry at a time.
//
// A baseline bounds it, and it is written only when the deltas since the last
// one cost about what the baseline costs. These cases pin the bound, the
// restore it must not break, and the parts of the journal that must keep
// working around it.

const TYPE = "scope.state";

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
    foldTo: (id) => {
      leafId = id;
    },
  };
  return { manager, written };
}

function anchorOver(manager, state) {
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

const quiet = () => {
  const state = createState();
  state.brackets = createBracketLedger();
  return state;
};

const fork = (state, forkId) => {
  const registered = registerFork(state.brackets, {
    forkId,
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);
};

const ledgerOf = (data) => (data.kind === "ledger" ? data : data.ledger);
const baselines = (written) =>
  written.filter((entry) => ledgerOf(entry.data)?.full === true).length;

/** A long run of writes to one record, touching nothing else. */
function churn(anchor, state, count, forkId = "a") {
  for (let index = 0; index < count; index += 1) {
    state.brackets.forks[forkId].task = `t${index}`;
    markRecordDirty(state.brackets, forkId);
    expect(anchor.persist()).toBe(true);
  }
}

describe("a journal that only ever grew", () => {
  test("writes baselines, so a cold start does not read the whole session", () => {
    const { manager, written } = journal();
    const state = quiet();
    const { anchor } = anchorOver(manager, state);

    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchor.persist();
    churn(anchor, state, 1500);

    // The bound: more than one baseline, and far fewer than one per write.
    expect(baselines(written)).toBeGreaterThan(1);
    expect(baselines(written)).toBeLessThan(written.length / 10);

    // And the journal still reads back exactly what it wrote.
    const restored = restoreState(manager);
    expect(restored.brackets.forks.a.task).toBe("t1499");
  });

  test("a record last written long ago still comes back whole", () => {
    const { manager } = journal();
    const state = quiet();
    const { anchor } = anchorOver(manager, state);

    fork(state, "old");
    state.brackets.forks.old.messages = Array.from({ length: 8 }, (_, index) => ({
      role: "user",
      text: `m${index}`,
    }));
    markLedgerStructDirty(state.brackets);
    anchor.persist();

    fork(state, "busy");
    markLedgerStructDirty(state.brackets);
    anchor.persist();
    churn(anchor, state, 900, "busy");

    // `old` was never mentioned again, and several baselines were written over
    // it — each one restates the whole tree, so it must carry `old` too.
    const restored = restoreState(manager);
    expect(restored.brackets.forks.old.messages.map((m) => m.text)).toEqual([
      "m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7",
    ]);
    expect(restored.brackets.forks.busy.task).toBe("t899");
  });
});

describe("the interval", () => {
  test("is longer for a journal that is expensive to restate", () => {
    const measure = (messages) => {
      const { manager, written } = journal();
      const state = quiet();
      const { anchor } = anchorOver(manager, state);
      fork(state, "a");
      if (messages > 0) {
        state.brackets.forks.a.messages = Array.from({ length: messages }, (_, index) => ({
          role: "user",
          text: `m${index} ${"y".repeat(300)}`,
        }));
      }
      markLedgerStructDirty(state.brackets);
      anchor.persist();
      churn(anchor, state, 1200);
      return baselines(written);
    };

    const small = measure(0);
    const large = measure(300);
    // A baseline carrying a transcript costs far more, so it is written far less
    // often — the total stays bounded instead of the interval being fixed.
    expect(large).toBeLessThan(small);
    expect(large).toBeGreaterThan(1);
  });

  test("restares a tree that changed after the last baseline", () => {
    const { manager, written } = journal();
    const state = quiet();
    const { anchor } = anchorOver(manager, state);

    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchor.persist();
    churn(anchor, state, 40);

    // A record that arrives after the last baseline must survive the next one.
    fork(state, "late");
    state.brackets.forks.late.messages = [{ role: "user", text: "late arrival" }];
    markLedgerStructDirty(state.brackets);
    expect(anchor.persist()).toBe(true);
    churn(anchor, state, 400);

    const restored = restoreState(manager);
    expect(restored.brackets.forks.late.messages).toEqual([
      { role: "user", text: "late arrival" },
    ]);
    expect(written.length).toBeGreaterThan(440);
  });
});

describe("after a load", () => {
  // A reload used to make the first write restate the whole ledger, because the
  // snapshot a delta subtracts from was rebuilt only by writing one. On a long
  // session that restatement is the largest single write it ever makes and every
  // byte of it is already in the journal. The seed is the ledger half of the
  // state the loader restored, named by the entry it came from.
  function reload(manager, state, seed = true) {
    const full = serializeStateShared(state);
    const parts = splitState(full);
    return createPersistenceAnchor({
      manager,
      state: () => state,
      initialState: parts.core,
      // `serializeStateShared` is the shop's cheap copy; the station passes the
      // copying serializer, and both are copies, which is the property the seed
      // depends on — a shared seed would hide an in-place record edit.
      initialLedger: seed ? parts.brackets : null,
      initialEntryId: manager.getLeafId(),
      serialize: serializeStateShared,
      plan: planStateEntry,
      planLedger: planLedgerEntry,
      split: splitState,
      type: TYPE,
      noteError: () => {},
    });
  }

  test("the first write after a load is a delta, not a restated baseline", () => {
    const { manager, written } = journal();
    const state = quiet();
    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchorOver(manager, state).anchor.persist();
    const before = baselines(written);
    expect(before).toBe(1);

    const reloaded = reload(manager, state);
    state.brackets.forks.a.task = "after the reload";
    markRecordDirty(state.brackets, "a");
    expect(reloaded.persist()).toBe(true);

    // The journal grew by what changed, and by no baseline.
    expect(baselines(written)).toBe(before);
    const entry = written.at(-1).data;
    expect(ledgerOf(entry).full).not.toBe(true);
    expect(restoreState(manager).brackets.forks.a.task).toBe("after the reload");
  });

  test("a reload with nothing changed writes nothing", () => {
    const { manager, written } = journal();
    const state = quiet();
    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchorOver(manager, state).anchor.persist();
    const count = written.length;

    // The seed must describe the live tree exactly. A snapshot that is merely
    // close writes a spurious delta here — or, worse, one that reports every
    // record as changed.
    expect(reload(manager, state).persist()).toBe(true);
    expect(written.length).toBe(count);
  });

  test("a branch cut before the first write drops the seed for a baseline", () => {
    const { manager, written } = journal();
    const state = quiet();
    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchorOver(manager, state).anchor.persist();
    const start = manager.getLeafId();
    const before = baselines(written);

    // A later entry the seed's id does not cover, then a cut back before it: the
    // journal no longer holds what the seed describes.
    const reloaded = reload(manager, state);
    state.brackets.forks.a.task = "discarded";
    markRecordDirty(state.brackets, "a");
    expect(reloaded.persist()).toBe(true);
    manager.foldTo(start);

    state.brackets.forks.a.task = "kept";
    markRecordDirty(state.brackets, "a");
    expect(reloaded.persist()).toBe(true);
    // The delta against a stranded seed would omit the change it no longer
    // holds; a baseline restates the live tree, so the value survives.
    expect(baselines(written)).toBeGreaterThan(before);
    expect(restoreState(manager).brackets.forks.a.task).toBe("kept");
  });

  test("a record edited in place after a load is still written", () => {
    const { manager, written } = journal();
    const state = quiet();
    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchorOver(manager, state).anchor.persist();

    const reloaded = reload(manager, state);
    // In-place edit on the very object the loader restored: the seed must be a
    // copy, or the identity fast path would answer "unchanged" for this write.
    state.brackets.forks.a.task = "in place";
    markRecordDirty(state.brackets, "a");
    expect(reloaded.persist()).toBe(true);
    expect(restoreState(manager).brackets.forks.a.task).toBe("in place");
  });
});

describe("the seed is only as good as the journal it claims", () => {
  // The seed says "the entry `initialEntryId` names already holds these records",
  // and a ledger delta is then written against it. The claim is checked for the
  // state half (is the entry a leaf ancestor?) but the ledger is a separate
  // domain: an entry can be a valid ancestor and carry no usable ledger baseline
  // — a state-only checkpoint, a ledger baseline that was pruned, a branch whose
  // ledger half stops earlier. When that happens the reader folds a different
  // text than the seed held, and the next `append` no longer meets its base.
  // The failure mode is not a wrong value: the chain fails and the restore
  // returns nothing at all. So the invariant these cases pin is the one that
  // matters — whatever the journal can fold, the seed must equal it, or the
  // first write after a load must be a baseline.
  function reload(manager, state, seed, seedId) {
    const parts = splitState(serializeStateShared(state));
    return createPersistenceAnchor({
      manager,
      state: () => state,
      initialState: parts.core,
      initialLedger: seed ? parts.brackets : null,
      initialEntryId: seedId ?? manager.getLeafId(),
      serialize: serializeStateShared,
      plan: planStateEntry,
      planLedger: planLedgerEntry,
      split: splitState,
      type: TYPE,
      noteError: () => {},
    });
  }

  test("a seeded append is still foldable after the reload", () => {
    const { manager } = journal();
    const state = quiet();
    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchorOver(manager, state).anchor.persist();
    // A record that a fork actually accumulates, so an `append` is emitted
    // rather than a whole-value `set`.
    state.brackets.forks.a.record = "step one. ";
    markRecordDirty(state.brackets, "a");
    anchorOver(manager, state).anchor.persist();

    const reloaded = reload(manager, state, true);
    state.brackets.forks.a.record += "step two. ";
    markRecordDirty(state.brackets, "a");
    expect(reloaded.persist()).toBe(true);

    // The reader must reach the same text through the journal, which is only
    // true if the seed's text was the journal's text.
    expect(restoreState(manager).brackets.forks.a.record).toBe("step one. step two. ");
  });

  test("a seed naming an entry the journal cannot back still restores", () => {
    const { manager } = journal();
    const state = quiet();
    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchorOver(manager, state).anchor.persist();
    state.brackets.forks.a.record = "step one. ";
    markRecordDirty(state.brackets, "a");
    anchorOver(manager, state).anchor.persist();

    // A seed that names an entry from another branch: the id is not an ancestor
    // of the leaf, so the snapshot must be dropped and the write must stand on
    // its own.
    const reloaded = reload(manager, state, true, "not-on-this-branch");
    state.brackets.forks.a.record += "step two. ";
    markRecordDirty(state.brackets, "a");
    expect(reloaded.persist()).toBe(true);
    expect(restoreState(manager).brackets.forks.a.record).toBe("step one. step two. ");
  });
});

describe("the checkpoint bounds entries, not state writes", () => {
  // The replay window a reader folds through is counted in *entries*, and every
  // turn appends one — a turn that moves only a fork record included. The
  // writer's `writes` counter counts state writes only, so a session that moves
  // records far more often than it moves the core used to reach the window with
  // its last checkpoint behind it and restore as nothing at all. These cases pin
  // the bound in the units the reader uses.
  function seeded(record = "") {
    const { manager, written } = journal();
    const state = createState();
    state.brackets = createBracketLedger();
    registerFork(state.brackets, {
      forkId: "a",
      ownerId: "/",
      fsm: "x",
      depth: 0,
      budget: { bash: 4 },
      profession: "You are a tester.",
    });
    state.brackets.forks.a.record = record;
    markLedgerStructDirty(state.brackets);
    const { anchor } = anchorOver(manager, state);
    anchor.persist();
    return { manager, written, state, anchor };
  }

  test("a session that only moves records still restores", () => {
    const { manager, written, state, anchor } = seeded();
    // Each turn changes one record and nothing in the core, so the state-write
    // counter stays where it is while the journal grows one entry per turn.
    for (let index = 0; index < 300; index += 1) {
      state.brackets.forks.a.record += `turn ${index}. `;
      markRecordDirty(state.brackets, "a");
      expect(anchor.persist()).toBe(true);
    }
    const checkpoints = written.filter((entry) => entry.data?.kind === "checkpoint");
    expect(checkpoints.length).toBeGreaterThan(1);
    // The distance the reader would have to fold is bounded by the writer, so a
    // cold restore still reaches the records instead of reporting an empty one.
    expect(restoreState(manager).brackets.forks.a.record).toBe(state.brackets.forks.a.record);
  });

  test("a quiet session writes no checkpoint it does not owe", () => {
    const { written, anchor } = seeded();
    const before = written.length;
    // Nothing changes across many turns: the counter cannot grow without an
    // append, so the forced checkpoint never fires on an idle turn.
    for (let index = 0; index < 300; index += 1) expect(anchor.persist()).toBe(true);
    expect(written.length).toBe(before);
  });
});

describe("around the baseline", () => {
  test("a branch cut still leaves the record the cut checkpoint established", () => {
    const { manager, written } = journal();
    const state = quiet();
    const { anchor } = anchorOver(manager, state);

    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchor.persist();
    const start = written.at(-1).id;

    state.brackets.forks.a.task = "after";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);

    manager.foldTo(start);
    const restored = restoreState(manager);
    expect(restored.brackets.forks.a).toBeDefined();
    expect(restored.brackets.forks.a.task).toBeUndefined();
  });

  test("a refused write leaves the interval where it was", () => {
    const { manager, written } = journal();
    const state = quiet();
    const { anchor } = anchorOver(manager, state);

    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchor.persist();

    const accept = manager.appendCustomEntry;
    let failures = 2;
    manager.appendCustomEntry = (type, data) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("disk full");
      }
      return accept(type, data);
    };

    for (const task of ["one", "two"]) {
      state.brackets.forks.a.task = task;
      markRecordDirty(state.brackets, "a");
      expect(anchor.persist()).toBe(false);
    }
    expect(anchor.persist()).toBe(true);

    // The debt is delivered by the write that succeeded, and the journal reads
    // back the last value the caller set.
    const restored = restoreState(manager);
    expect(restored.brackets.forks.a.task).toBe("two");
    expect(baselines(written)).toBeGreaterThanOrEqual(1);
  });
});
