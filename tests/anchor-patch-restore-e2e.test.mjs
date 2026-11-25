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

// A session writes twice: once as a checkpoint, then as deltas. A fork record
// carries the conversation, so a change to its status must not write the
// transcript again — it travels as a patch, in a field of its own.
//
// The contract is what a restart reads, not the shape of the entry. These cases
// take the real anchor through its real writes into the real journal, then read
// it back the way a process start does: the record must come back whole, a
// patch with no baseline must fail the chain, and a retry after a refused write
// must still deliver.

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
    foldTo: (id) => {
      expect(entries.has(id)).toBe(true);
      leafId = id;
    },
  };
  return { manager, written, entries };
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

const ledgerOf = (data) => (data.kind === "ledger" ? data : data.ledger);

describe("a record that changed between a checkpoint and a restart", () => {
  test("comes back whole, including the history the patch did not carry", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor, errors } = anchorFor(manager, state);

    register(state, "a");
    expect(anchor.persist()).toBe(true);
    expect(written.at(-1).data.kind).toBe("checkpoint");

    // The conversation grows well past what a small entry could carry.
    state.brackets.forks.a.messages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      text: `m${index} ${"x".repeat(120)}`,
    }));
    markLedgerStructDirty(state.brackets);
    expect(anchor.persist()).toBe(true);

    // Now only the status moves. This is the write that used to repeat the
    // transcript.
    state.brackets.forks.a.task = "edited";
    state.brackets.forks.a.status = "ready";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);
    const last = ledgerOf(written.at(-1).data);
    expect(last.patches?.a).toBeArray();
    expect(last.set?.a).toBeUndefined();
    // The patch is a fraction of the record it edits.
    expect(JSON.stringify(last.patches.a).length).toBeLessThan(
      JSON.stringify(state.brackets.forks.a).length / 20,
    );
    expect(errors).toEqual([]);

    // A restart reads the branch it was left.
    const restored = restoreState(manager);
    expect(restored.brackets.forks.a.task).toBe("edited");
    expect(restored.brackets.forks.a.status).toBe("ready");
    expect(restored.brackets.forks.a.messages).toHaveLength(40);
    expect(restored.brackets.forks.a.messages[39].text).toBe(`m39 ${"x".repeat(120)}`);
  });

  test("survives several patches in a row", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    anchor.persist();
    state.brackets.forks.a.messages = Array.from({ length: 10 }, (_, index) => ({
      role: "user",
      text: `m${index}`,
    }));
    markLedgerStructDirty(state.brackets);
    anchor.persist();

    for (const task of ["one", "two", "three"]) {
      state.brackets.forks.a.task = task;
      markRecordDirty(state.brackets, "a");
      expect(anchor.persist()).toBe(true);
    }

    const restored = restoreState(manager);
    expect(restored.brackets.forks.a.task).toBe("three");
    expect(restored.brackets.forks.a.messages.map((m) => m.text)).toEqual([
      "m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9",
    ]);
    // Every write after the checkpoint was a patch, never a whole copy.
    const after = written.slice(1).map(ledgerOf);
    expect(after.filter((entry) => entry?.set?.a !== undefined)).toHaveLength(0);
  });
});

describe("a ledger-only write", () => {
  test("carries its patch into a restart", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    anchor.persist();
    const checkpointId = written.at(-1).id;

    // A ledger-only entry holds fork records and no serialized state.
    state.brackets.forks.a.messages = [{ role: "user", text: "kept" }];
    markLedgerStructDirty(state.brackets);
    anchor.persist();
    state.brackets.forks.a.task = "only the ledger moved";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);

    const restored = restoreState(manager);
    expect(restored.brackets.forks.a.task).toBe("only the ledger moved");
    expect(restored.brackets.forks.a.messages).toEqual([{ role: "user", text: "kept" }]);
    expect(checkpointId).toBeDefined();
  });
});

describe("a branch cut", () => {
  test("a patch with no baseline fails as a chain, not as a truncated record", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    anchor.persist();
    const checkpointId = written.at(-1).id;

    state.brackets.forks.a.task = "after the cut";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);

    // Cut back to the checkpoint: the patch is gone, and the record is the one
    // the checkpoint established. The patch must not be applied to the older
    // record as if the cut had not happened — that would show a task on a
    // record that never carried one.
    manager.foldTo(checkpointId);
    const restored = restoreState(manager);
    expect(restored.brackets.forks.a).toBeDefined();
    expect(restored.brackets.forks.a.task).toBeUndefined();
  });

  test("a patch that stays in the branch without its establishing entry fails the chain", () => {
    const { manager, written, entries } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    anchor.persist();
    const checkpointId = written.at(-1).id;

    state.brackets.forks.a.task = "after the cut";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(true);
    const patchId = written.at(-1).id;

    // The patch reaches the leaf but the entry that established the record does
    // not: the branch is rewired so the patch's parent is the tree's root. This
    // is the shape a real cut leaves — the patch is present and would be folded,
    // and the record it names was never established.
    //
    // Cutting the leaf back to the checkpoint instead (which is what this case
    // originally did) only removes the patch from the branch, and says nothing
    // about a patch that is still there.
    entries.get(patchId).parentId = "base";
    manager.foldTo(patchId);

    // The fixture really holds the shape this case is about: the patch is on
    // the branch and the checkpoint that established the record is not.
    const branch = manager.getBranch().map((entry) => entry.id);
    expect(branch).toEqual(["base", patchId]);
    expect(branch).not.toContain(checkpointId);
    expect(ledgerOf(entries.get(patchId).data).patches.a).toBeArray();

    const restored = restoreState(manager);
    // Refused as a chain. Applying the patch to `{}` would keep the task and
    // lose every other field, which reads as a healthy fork with no history.
    expect(restored.brackets.forks.a?.task).toBeUndefined();
    expect(restored.brackets.forks.a).toBeUndefined();
    expect(checkpointId).toBeDefined();
  });
});

describe("a write the journal refused", () => {
  test("the retry still delivers the record", () => {
    const { manager, written } = journal();
    const state = freshState();
    const { anchor } = anchorFor(manager, state);

    register(state, "a");
    anchor.persist();
    state.brackets.forks.a.messages = Array.from({ length: 5 }, (_, index) => ({
      role: "user",
      text: `m${index}`,
    }));
    markLedgerStructDirty(state.brackets);
    anchor.persist();

    // The host drops one append, then accepts the next.
    const accept = manager.appendCustomEntry;
    let failures = 1;
    manager.appendCustomEntry = (type, data) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("disk full");
      }
      return accept(type, data);
    };

    state.brackets.forks.a.task = "retried";
    markRecordDirty(state.brackets, "a");
    expect(anchor.persist()).toBe(false);

    // The same debt is still owed; the next attempt writes it.
    expect(anchor.persist()).toBe(true);

    const restored = restoreState(manager);
    expect(restored.brackets.forks.a.task).toBe("retried");
    expect(restored.brackets.forks.a.messages).toHaveLength(5);
    expect(written.length).toBeGreaterThan(0);
  });
});
