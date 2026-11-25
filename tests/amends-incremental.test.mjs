// The retired-beat list is written as an increment, not as a copy.
//
// `amends` is append-only and deduplicated: the only writer pushes a key it has
// just proved absent. That makes its length the whole story of what a journal
// is missing, so a write after the first names only the keys it added. Before
// this, every persist copied the whole list into the core payload and a deep
// diff walked it element by element — a cost that grew with the session.
//
// These cases drive the production anchor: real planners, real fold, real
// restore. The first write of a process restates the list (there is nothing to
// subtract from), and every write after it names the suffix.

import { describe, expect, test } from "bun:test";

import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";
import {
  createState,
  planAmendsEntry,
  planLedgerEntry,
  planStateEntry,
  splitState,
  serializeStateShared,
  foldStateChain,
  deserializeState,
} from "../src/scope/index.mjs";

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
      written.push(data);
      return id;
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
    planAmends: planAmendsEntry,
    split: splitState,
    type: "scope.state",
    noteError: (where, error) => errors.push({ where, error: String(error) }),
  });
  return { anchor, errors };
}

/** What a reload sees: the journal folded and normalized. */
function reload(written) {
  const folded = foldStateChain(written);
  return folded === null ? null : deserializeState(folded);
}

describe("the list as an increment", () => {
  test("the first write restates it, later writes name only the suffix", () => {
    const { manager, written } = journal();
    const state = createState();
    const { anchor, errors } = anchorFor(manager, state);

    state.amends.push("beat-1");
    expect(anchor.persist()).toBe(true);
    const first = written.at(-1);
    // Nothing to subtract from on the first write, so the whole list travels.
    expect(first.amends?.amends).toEqual(["beat-1"]);

    state.amends.push("beat-2");
    expect(anchor.persist()).toBe(true);
    const second = written.at(-1);
    // Only the key that was added; the list itself is not restated.
    expect(second.amends?.amendsAppend).toEqual(["beat-2"]);
    expect(second.amends?.amends).toBeUndefined();

    state.amends.push("beat-3");
    expect(anchor.persist()).toBe(true);
    expect(written.at(-1).amends?.amendsAppend).toEqual(["beat-3"]);
    expect(errors).toEqual([]);

    expect(reload(written).amends).toEqual(["beat-1", "beat-2", "beat-3"]);
  });

  test("a quiet write owes nothing", () => {
    const { manager, written } = journal();
    const state = createState();
    const { anchor } = anchorFor(manager, state);

    state.amends.push("beat-1");
    expect(anchor.persist()).toBe(true);
    const count = written.length;

    // Nothing moved anywhere: no state delta, no ledger change, no new key.
    expect(anchor.persist()).toBe(true);
    expect(written.length).toBe(count);
  });

  test("one entry carries a key and a record change together", () => {
    const { manager, written } = journal();
    const state = createState();
    const { anchor, errors } = anchorFor(manager, state);

    state.amends.push("beat-1");
    expect(anchor.persist()).toBe(true);

    // Both halves are owed at once: a new retired key and a new state field.
    state.amends.push("beat-2");
    state.seq = 7;
    expect(anchor.persist()).toBe(true);
    const entry = written.at(-1);
    expect(entry.amends?.amendsAppend).toEqual(["beat-2"]);
    // The state payload is still in the same entry, so neither can land alone.
    expect(entry.kind === "delta" || entry.kind === "checkpoint").toBe(true);
    expect(errors).toEqual([]);

    const restored = reload(written);
    expect(restored.amends).toEqual(["beat-1", "beat-2"]);
    expect(restored.seq).toBe(7);
  });

  test("a restarted process restates the list without resurrecting it twice", () => {
    const { manager, written } = journal();
    const state = createState();
    const first = anchorFor(manager, state);
    state.amends.push("beat-1");
    expect(first.anchor.persist()).toBe(true);
    state.amends.push("beat-2");
    expect(first.anchor.persist()).toBe(true);

    // A new process reads the journal, then writes again: it has no recorded
    // length, so its first write is a baseline — a replacement, not an append
    // to a list it only half knows.
    const restoredState = deserializeState(foldStateChain(written));
    expect(restoredState.amends).toEqual(["beat-1", "beat-2"]);

    const second = anchorFor(manager, restoredState);
    expect(second.anchor.persist()).toBe(true);
    const baseline = written.at(-1);
    expect(baseline.amends?.amends).toEqual(["beat-1", "beat-2"]);

    restoredState.amends.push("beat-3");
    expect(second.anchor.persist()).toBe(true);
    expect(written.at(-1).amends?.amendsAppend).toEqual(["beat-3"]);

    expect(reload(written).amends).toEqual(["beat-1", "beat-2", "beat-3"]);
  });

  test("a list that shrank is restated rather than appended to", () => {
    const state = createState();
    state.amends.push("a", "b");
    const first = planAmendsEntry(state, null);
    expect(first.entry.amends).toEqual(["a", "b"]);

    // A restore installs a shorter list (a test fixture, or a reset). Emitting
    // a suffix would append to whatever the journal already holds, so the
    // planner restates it instead.
    state.amends = ["a"];
    const second = planAmendsEntry(state, 2);
    expect(second.entry.amends).toEqual(["a"]);
    expect(second.entry.amendsAppend).toBeUndefined();
    expect(second.length).toBe(1);

    const folded = foldStateChain([
      { version: 3, kind: "amends", amends: ["a", "b"] },
      { version: 3, kind: "amends", amends: ["a"] },
    ]);
    expect(folded.amends).toEqual(["a"]);
  });

  test("an archive written before the split still loads its list", () => {
    // A checkpoint from the format that carried `amends` in the core payload.
    const legacy = { version: 2, kind: "checkpoint", state: { seq: 1, amends: ["old-1", "old-2"] } };
    const folded = foldStateChain([legacy]);
    // No amends entry exists, so the checkpoint's own list stands.
    expect(folded.amends).toEqual(["old-1", "old-2"]);
  });

  test("a delta's empty list does not erase the folded one", () => {
    // The core no longer carries the list, so a delta's ops still say
    // `amends: []`. The amends entry is folded last and must win.
    const folded = foldStateChain([
      { version: 3, kind: "checkpoint", state: { seq: 1, amends: [] } },
      { version: 3, kind: "amends", amends: ["kept"] },
      { version: 3, kind: "delta", ops: [{ path: ["amends"], value: [] }] },
    ]);
    expect(folded.amends).toEqual(["kept"]);
  });
});
