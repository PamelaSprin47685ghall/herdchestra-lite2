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

// A changed record now travels as a patch against the copy the reader already
// holds, so a write depends on a baseline that may be hundreds of entries older
// than it is. Restore therefore has to reach that baseline, and the state chain
// has a hard bound (`MAX_REPLAY_ENTRIES`) that the ledger log does not share.
//
// If the ledger log were bounded the same way, a fork untouched for a long run
// would lose the entry that established it, and the next patch naming it would
// have no record to apply to — the chain would be refused and the whole session
// would come back empty. These cases push past that bound and read it back.

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
  return createPersistenceAnchor({
    manager,
    state: () => state,
    initialState: null,
    initialEntryId: null,
    serialize: serializeStateShared,
    plan: planStateEntry,
    planLedger: planLedgerEntry,
    split: splitState,
    type: TYPE,
    noteError: () => {},
  });
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

describe("a record last written long before the restart", () => {
  test("survives a run longer than the state chain's replay bound", () => {
    const { manager, written } = journal();
    const state = quiet();
    const anchor = anchorOver(manager, state);

    // Established early, then never touched again.
    fork(state, "old");
    state.brackets.forks.old.messages = Array.from({ length: 5 }, (_, index) => ({
      role: "user",
      text: `m${index} `.repeat(50),
    }));
    markLedgerStructDirty(state.brackets);
    expect(anchor.persist()).toBe(true);

    // A different record takes every subsequent write.
    fork(state, "busy");
    markLedgerStructDirty(state.brackets);
    expect(anchor.persist()).toBe(true);

    const WRITES = 600;
    for (let index = 0; index < WRITES; index += 1) {
      state.brackets.forks.busy.task = `task ${index}`;
      markRecordDirty(state.brackets, "busy");
      expect(anchor.persist()).toBe(true);
    }

    // The run is longer than the bound the state chain applies, so a bounded
    // ledger log would have dropped the entry that established `old`.
    expect(written.length).toBeGreaterThan(512);

    const restored = restoreState(manager);
    expect(restored.brackets.forks.old).toBeDefined();
    expect(restored.brackets.forks.old.messages).toHaveLength(5);
    expect(restored.brackets.forks.old.messages[4].text).toBe(`m4 `.repeat(50));
    expect(restored.brackets.forks.busy.task).toBe(`task ${WRITES - 1}`);
  });

  test("a record touched only once still comes back whole after many quiet writes", () => {
    const { manager } = journal();
    const state = quiet();
    const anchor = anchorOver(manager, state);

    fork(state, "old");
    state.brackets.forks.old.messages = [{ role: "user", text: "kept" }];
    markLedgerStructDirty(state.brackets);
    anchor.persist();

    // Only the state moves — no record changes at all.
    for (let index = 0; index < 700; index += 1) {
      state.seq = index;
      expect(anchor.persist()).toBe(true);
    }

    const restored = restoreState(manager);
    expect(restored.brackets.forks.old.messages).toEqual([{ role: "user", text: "kept" }]);
  });
});

describe("the cost of a patch against a long record", () => {
  test("names the change, not the history", () => {
    const state = quiet();
    fork(state, "a");
    state.brackets.forks.a.messages = Array.from({ length: 300 }, (_, index) => ({
      role: "user",
      text: "y".repeat(300),
    }));
    let plan = planLedgerEntry(state, null);

    const whole = JSON.stringify(plan.brackets.forks.a).length;
    let written = 0;
    for (let index = 0; index < 20; index += 1) {
      state.brackets.forks.a.task = `t${index}`;
      markRecordDirty(state.brackets, "a");
      plan = planLedgerEntry(state, plan.brackets);
      written += JSON.stringify(plan.entry.patches.a).length;
    }

    // The record is ~90 KB; a status change is a hundred-odd bytes.
    expect(whole).toBeGreaterThan(50000);
    expect(written / 20).toBeLessThan(whole / 100);
  });
});
