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

// A baseline is a periodic write nobody asked for, so it has three ways to go
// wrong that a user would feel: it can fire when nothing changed, it can be
// measured in the wrong unit and fire too late on the sessions that need it,
// and it can fail after the host already accepted the line — which the retry
// then repeats, growing the journal by a second copy of a change it holds.

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
  return { manager, entries, written };
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

const ledgerOf = (data) => (data.kind === "ledger" ? data : data.ledger);
const baselines = (written) =>
  written.filter((entry) => ledgerOf(entry.data)?.full === true).length;

describe("a write nobody asked for", () => {
  test("an idle persist writes nothing, however long the run has been", () => {
    const { manager, written } = journal();
    const state = quiet();
    const anchor = anchorOver(manager, state);

    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchor.persist();

    // A long run of real changes, enough to cross the baseline interval.
    for (let index = 0; index < 1400; index += 1) {
      state.brackets.forks.a.task = `t${index}`;
      markRecordDirty(state.brackets, "a");
      expect(anchor.persist()).toBe(true);
    }
    expect(baselines(written)).toBeGreaterThan(1);

    // Nothing owes anything now. The interval is satisfied and a baseline is
    // due by count, but there is no change to carry: a write here would be a
    // whole-tree restatement in answer to nothing.
    const settled = written.length;
    for (let index = 0; index < 200; index += 1) {
      expect(anchor.persist()).toBe(true);
    }
    expect(written.length).toBe(settled);
  });

  test("a baseline that has come due writes nothing when nothing moved", () => {
    const { manager, written } = journal();
    const state = quiet();
    const anchor = anchorOver(manager, state);

    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchor.persist();

    // Push the interval all the way round: the deltas since the last baseline
    // cross the count ceiling, so the next call *would* write a baseline.
    for (let index = 0; index < 2600; index += 1) {
      state.brackets.forks.a.task = `t${index}`;
      markRecordDirty(state.brackets, "a");
      expect(anchor.persist()).toBe(true);
    }
    expect(baselines(written)).toBeGreaterThan(1);

    // Now go quiet. A baseline is due by interval, and one that respects the
    // interval alone would restate the whole tree here — a whole-tree write in
    // answer to a turn that owes nothing.
    const settled = written.length;
    for (let index = 0; index < 50; index += 1) {
      expect(anchor.persist()).toBe(true);
    }
    expect(written.length).toBe(settled);

    // And the journal still reads back the last value the caller set.
    expect(restoreState(manager).brackets.forks.a.task).toBe("t2599");
  });

  test("the same change is not written twice", () => {
    const { manager, written } = journal();
    const state = quiet();
    const anchor = anchorOver(manager, state);

    fork(state, "a");
    markLedgerStructDirty(state.brackets);
    anchor.persist();

    state.brackets.forks.a.task = "once";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);
    const after = written.length;

    // The anchor advanced its own accounting with the write, so a second call
    // owes nothing and must not restate the change it already delivered.
    expect(anchor.persist()).toBe(true);
    expect(written.length).toBe(after);

    const restored = restoreState(manager);
    expect(restored.brackets.forks.a.task).toBe("once");
  });
});

describe("the unit the bytes are counted in", () => {
  test("a Chinese transcript reaches the interval, it is not measured as a third of it", () => {
    // `String.length` counts UTF-16 units, so these strings measure a third of
    // their size in bytes. A threshold on that number fires three times too
    // late, and the journal is left holding several times a baseline between
    // restatements.
    const { manager, written } = journal();
    const state = quiet();
    const anchor = anchorOver(manager, state);

    fork(state, "a");
    state.brackets.forks.a.messages = Array.from({ length: 40 }, () => ({
      role: "user",
      // 400 characters, ~1200 bytes.
      text: "中文对话内容".repeat(67),
    }));
    markLedgerStructDirty(state.brackets);
    anchor.persist();

    for (let index = 0; index < 400; index += 1) {
      state.brackets.forks.a.messages.push({ role: "user", text: `第${index}条中文消息` });
      markRecordDirty(state.brackets, "a");
      expect(anchor.persist()).toBe(true);
    }

    // The interval is derived from the baseline, so this is a ratio rather than
    // an absolute: the deltas since a baseline must not run far past it.
    const ledgerEntries = written.map((entry) => ledgerOf(entry.data)).filter(Boolean);
    let accumulated = 0;
    let worst = 0;
    for (const entry of ledgerEntries) {
      const bytes = Buffer.byteLength(JSON.stringify(entry) ?? "", "utf8");
      if (entry.full === true) {
        worst = Math.max(worst, accumulated);
        accumulated = 0;
      } else {
        accumulated += bytes;
      }
    }
    worst = Math.max(worst, accumulated);
    const lastBaseline = [...ledgerEntries].reverse().find((entry) => entry.full === true);
    const baselineBytes = Buffer.byteLength(JSON.stringify(lastBaseline) ?? "", "utf8");

    expect(lastBaseline).toBeDefined();
    // One interval of deltas costs about one baseline, not several.
    expect(worst).toBeLessThan(baselineBytes * 2.5);

    // And the conversation still reads back whole.
    const restored = restoreState(manager);
    expect(restored.brackets.forks.a.messages).toHaveLength(440);
  });
});
