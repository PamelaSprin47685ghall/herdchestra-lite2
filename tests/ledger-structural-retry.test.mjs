// The structural guard is load-bearing only in one order of events: register
// first, fail the append, mark a record, then retry.
//
// A failed append is not a no-op. `planLedgerEntry` reads the live containers
// and records them in `lastLive` before the host is asked to write, and the
// serializer consumes the one-shot structural mark while building the snapshot
// it hands back. So after a failure the two cheap readings both say "nothing
// moved": the containers match `lastLive`, and the mark is gone. What still
// knows the truth is the separate unsettled flag, which only an accepted write
// clears.
//
// Without that flag the retry takes the record-only shortcut, names just the
// record it was told about, reuses the previous `order` by reference, and drops
// the newly registered fork. Nothing reports an error: the stored tree is still
// self-consistent, it simply never mentions that fork again.

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
  foldStateChain,
  validLedger,
  markRecordDirty,
} from "../src/scope/index.mjs";
import {
  commitPersisted,
  ledgerPending,
  registerLedger,
} from "../src/scope/ledger-cache.mjs";

function freshState() {
  const state = createState();
  state.brackets = createBracketLedger();
  registerLedger(state.brackets);
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

describe("register, then a failed append, then a record edit, then retry", () => {
  test("the fork registered before the failure is not lost", () => {
    const { manager, written } = journal();
    const state = freshState();
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

    // A durable baseline with one fork.
    register(state, "a");
    expect(anchor.persist()).toBe(true);

    // The new fork is registered first, and the write that would carry it
    // fails. The failed attempt still recorded the live containers in
    // `lastLive` and consumed the structural mark.
    register(state, "b");
    manager.failNext();
    expect(anchor.persist()).toBe(false);
    expect(errors.length).toBe(1);

    // Registration and the later edit both remain owed until the retry lands.
    state.brackets.forks.a.task = "a, edited";
    markRecordDirty(state.brackets, "a");
    expect(ledgerPending(state.brackets).records.sort()).toEqual(["a", "b"]);
    expect(ledgerPending(state.brackets).struct).toBe(true);

    expect(anchor.persist()).toBe(true);
    expect(errors.length).toBe(1);

    const folded = foldStateChain(written);
    expect(folded).not.toBeNull();
    expect(validLedger(folded.brackets)).toBe(true);
    // The whole point: "b" exists, with a record and a place in `order`.
    expect(Object.keys(folded.brackets.forks).sort()).toEqual(["a", "b"]);
    expect(folded.brackets.order).toEqual(["a", "b"]);
    expect(folded.brackets.forks.a.task).toBe("a, edited");
    expect(folded.brackets.forks.b.forkId).toBe("b");
  });

  test("a structural-only retry after the same failure is not silently empty", () => {
    const state = freshState();
    registerLedger(state.brackets);
    register(state, "a");
    let previous = planLedgerEntry(state, null);
    commitPersisted(state.brackets);

    // Register, then discard the answer as a failed append would: `lastBrackets`
    // never advances, so the retry subtracts from the older snapshot.
    register(state, "b");
    const failed = planLedgerEntry(state, previous.brackets);
    expect(failed.entry).toBeTruthy();
    // Only the record that appeared is written; "a" is unchanged and its copy
    // in the previous snapshot still stands, so it costs no bytes.
    expect(Object.keys(failed.entry.set)).toEqual(["b"]);

    // The retry runs against the same durable snapshot and the same live tree.
    const retry = planLedgerEntry(state, previous.brackets);
    expect(retry.refused).toBeUndefined();
    expect(retry.entry).toBeTruthy();
    // It must still name the new record, even though the structural mark was
    // consumed by the failed attempt: the unsettled flag is what remembers it.
    expect(Object.keys(retry.entry.set)).toEqual(["b"]);
    // And the header must still carry the new id, or `order` would name a fork
    // the journal has never stored a record for.
    expect(retry.entry.orderOps?.append).toEqual(["b"]);

    const folded = foldStateChain([previous.entry, retry.entry].filter(Boolean));
    expect(validLedger(folded.brackets)).toBe(true);
    expect(Object.keys(folded.brackets.forks).sort()).toEqual(["a", "b"]);
    expect(folded.brackets.order).toEqual(["a", "b"]);
  });
});
