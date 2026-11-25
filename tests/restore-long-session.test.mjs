import { describe, expect, test } from "bun:test";

import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";
import { hasPersistedBase, restoreState } from "../src/station/restore.mjs";
import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  planStateEntry,
  splitState,
  serializeState,
  serializeStateShared,
  serializeStateCore,
  diffState,
  markLedgerStructDirty,
} from "../src/scope/index.mjs";

// A state delta is meaningless without the checkpoint it is a delta against, so
// every delta newer than that checkpoint has to travel with it: no subset of a
// delta chain recovers the same state. A bound on how many entries to read
// therefore cannot save work — it only decides whether a session comes back.
//
// Restore used to stop scanning after 512 state entries. A real 5 GB session
// reached 743 entries from its last checkpoint (written before the writer
// bounded its own checkpoint distance, `CHECKPOINT_ENTRY_LIMIT`) and every
// later load returned nothing: the branch still held the checkpoint, and the
// ledger domain still held its own baseline, but the state chain had been cut
// above the only entry that could anchor it. Those journals are on disk and
// still opened, so the reader cannot assume the writer's newer bound.
//
// These cases build that shape by hand — one real checkpoint, then real deltas
// produced by the real diff — because the current writer will not produce it.

const TYPE = "scope.state";

function journal() {
  let leafId = "base";
  let serial = 0;
  const entries = new Map([["base", { id: "base", parentId: null }]]);
  const written = [];
  const manager = {
    getLeafId: () => leafId,
    getLeafEntry: () => entries.get(leafId),
    getEntry: (id) => entries.get(id),
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

const quiet = () => {
  const state = createState();
  state.brackets = createBracketLedger();
  return state;
};

function worker(state) {
  const registered = registerFork(state.brackets, {
    forkId: "worker",
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 5 },
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);
  state.brackets.forks.worker.task = "established early";
  markLedgerStructDirty(state.brackets);
}

/**
 * Write a checkpoint, then `turns` deltas with no checkpoint between them, the
 * way a journal written before `CHECKPOINT_ENTRY_LIMIT` looks.
 */
function longRun(manager, state, turns) {
  // The real planner, with no baseline: the only shape that opens a chain.
  const opening = planStateEntry(null, serializeState(state));
  expect(opening.kind).toBe("checkpoint");
  manager.appendCustomEntry(TYPE, opening);
  const ledgerOpening = planLedgerEntry(state, null);
  manager.appendCustomEntry(TYPE, { version: 3, kind: "ledger", ...ledgerOpening.entry });

  let previous = splitState(serializeState(state)).core;
  for (let index = 0; index < turns; index += 1) {
    state.seq = index + 1;
    const next = serializeStateCore(state);
    const ops = diffState(previous, next);
    expect(ops.length).toBeGreaterThan(0);
    // Always a delta, even past the writer's own checkpoint interval: this is
    // the journal shape the reader must still be able to open.
    manager.appendCustomEntry(TYPE, { version: 3, kind: "delta", ops });
    previous = next;
  }
}

describe("a journal whose checkpoint is far behind the leaf", () => {
  test("restores the session instead of returning nothing", () => {
    const { manager, written } = journal();
    const state = quiet();
    worker(state);
    const TURNS = 700;
    longRun(manager, state, TURNS);

    const states = written.filter((entry) => ["checkpoint", "delta"].includes(entry.data.kind));
    expect(states).toHaveLength(TURNS + 1);
    expect(states.filter((entry) => entry.data.kind === "checkpoint")).toHaveLength(1);
    // Past the old bound by a wide margin: this is the shape that used to be
    // declared unreadable.
    expect(states.length).toBeGreaterThan(512);

    const diagnostics = [];
    const restored = restoreState(manager, (where, error) => diagnostics.push(`${where}: ${error.message}`));

    expect(diagnostics).toEqual([]);
    expect(restored.brackets.forks.worker).toBeDefined();
    expect(restored.brackets.forks.worker.task).toBe("established early");
    // The deltas were folded, not skipped: the last one's value is present.
    expect(restored.seq).toBe(TURNS);
  });

  test("reports a base to the writer, so the next load writes a delta", () => {
    const { manager } = journal();
    const state = quiet();
    worker(state);
    longRun(manager, state, 700);
    // Answering "no base" here would make the next load write a whole
    // checkpoint over a session whose base is intact but far away.
    expect(hasPersistedBase(manager)).toBe(true);
  });

  test("folds ledger records that were established before the checkpoint moved on", () => {
    const { manager, written } = journal();
    const state = quiet();
    worker(state);
    longRun(manager, state, 600);
    // A record that only moves after the long run: its patch needs the ledger
    // baseline written at the very start of the branch.
    state.brackets.forks.worker.task = "moved late";
    const late = planLedgerEntry(state, null);
    manager.appendCustomEntry(TYPE, { version: 3, kind: "ledger", ...late.entry });

    const restored = restoreState(manager, () => {});
    expect(restored.brackets.forks.worker.task).toBe("moved late");
    expect(written.length).toBeGreaterThan(602);
  });
});

describe("a branch that holds no checkpoint at all", () => {
  test("restores nothing, and says why", () => {
    const { manager, written } = journal();
    const state = quiet();
    worker(state);

    // A branch that never carried a checkpoint: every entry is a delta against
    // a base nothing on the branch holds. This is what a pruned or truncated
    // branch looks like, and no delta chain can be opened from it.
    let previous = splitState(serializeState(state)).core;
    for (let index = 0; index < 40; index += 1) {
      state.seq = index + 1;
      const next = serializeStateCore(state);
      manager.appendCustomEntry(TYPE, { version: 3, kind: "delta", ops: diffState(previous, next) });
      previous = next;
    }
    expect(written.every((entry) => entry.data.kind === "delta")).toBe(true);

    const diagnostics = [];
    const restored = restoreState(manager, (where, error) => diagnostics.push(`${where}: ${error.message}`));
    expect(restored.brackets.forks).toEqual({});
    expect(restored.seq).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("no checkpoint");
    // The writer must not treat that as a base either.
    expect(hasPersistedBase(manager)).toBe(false);
  });
});

describe("the anchor still bounds its own checkpoint distance", () => {
  test("a long run through the anchor keeps a checkpoint within reach", () => {
    const { manager, written } = journal();
    const state = quiet();
    worker(state);
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
      noteError: () => {},
    });
    expect(anchor.persist()).toBe(true);
    for (let index = 0; index < 700; index += 1) {
      state.seq = index + 1;
      expect(anchor.persist()).toBe(true);
    }
    // The writer's guarantee is what keeps the reader's walk short in new
    // journals; the reader no longer relies on it, but it must still hold.
    const states = written.filter((entry) => ["checkpoint", "delta"].includes(entry.data.kind));
    const newest = states.map((entry, index) => (entry.data.kind === "checkpoint" ? index : -1)).filter((i) => i >= 0);
    expect(newest.length).toBeGreaterThan(1);
    expect(states.length - 1 - newest.at(-1)).toBeLessThan(256);
    expect(restoreState(manager).seq).toBe(700);
  });
});
