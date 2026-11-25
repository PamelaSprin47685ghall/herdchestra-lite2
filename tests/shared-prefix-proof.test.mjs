// Two soundness questions about the fast paths added for a long session.
//
// 1. A snapshot may tell the journal how many leading entries it shares with
//    the snapshot before it. That number is only true *for that snapshot*, so
//    a consumer whose baseline is older — or whose baseline predates a mailbox
//    replacement — must not use it. The mark is bound to the array it was
//    computed against; everything else falls back to the walk.
// 2. A record that really changed must still reach the next snapshot.

import { describe, expect, test } from "bun:test";

import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  foldStateChain,
  markLedgerStructDirty,
} from "../src/scope/index.mjs";
import { registerLedger } from "../src/scope/ledger-cache.mjs";
import {
  createAppendOnlyInbox,
  markSharedPrefix,
  sharedPrefixFor,
} from "../src/scope/append-only-inbox.mjs";

function freshState() {
  const state = createState();
  state.brackets = createBracketLedger();
  registerLedger(state.brackets);
  const ok = registerFork(state.brackets, {
    forkId: "a",
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(ok.ok).toBe(true);
  return state;
}

const deliver = (state, message) => {
  state.brackets.rootInbox.push({ from: "/", message, envelope: message });
  markLedgerStructDirty(state.brackets);
};

describe("a shared prefix belongs to the snapshot it was measured against", () => {
  test("a consumer with an older baseline still compares every entry", () => {
    const state = freshState();
    deliver(state, "a");
    deliver(state, "b");
    const first = planLedgerEntry(state, null);

    deliver(state, "c");
    const second = planLedgerEntry(state, first.brackets);
    expect(second.entry.rootInboxAppend).toHaveLength(1);

    deliver(state, "d");
    // `first` is two snapshots behind, so second's mark does not apply to it.
    const third = planLedgerEntry(state, first.brackets);
    expect(third.entry.rootInboxAppend.map((item) => item.message)).toEqual(["c", "d"]);
    expect(
      foldStateChain([first.entry, third.entry]).brackets.rootInbox.map((item) => item.message),
    ).toEqual(["a", "b", "c", "d"]);
  });

  test("a mailbox replaced between two snapshots cannot hide the rewrite", () => {
    const state = freshState();
    deliver(state, "old");
    deliver(state, "tail");
    const first = planLedgerEntry(state, null);

    // Same length, different content in the first slot, then an append. If the
    // mark were a bare count, the consumer would skip index 0 and store only the
    // tail, losing the replacement.
    state.brackets.rootInbox = createAppendOnlyInbox();
    deliver(state, "new");
    deliver(state, "tail");
    deliver(state, "more");
    const next = planLedgerEntry(state, first.brackets);

    expect(next.entry.rootInboxAppend).toBeUndefined();
    expect(next.entry.rootInbox.map((item) => item.message)).toEqual(["new", "tail", "more"]);
    expect(
      foldStateChain([first.entry, next.entry]).brackets.rootInbox.map((item) => item.message),
    ).toEqual(["new", "tail", "more"]);
  });

  test("the mark answers only for its own base array", () => {
    const base = [];
    expect(sharedPrefixFor(markSharedPrefix([], 0, base), base)).toBe(0);
    expect(sharedPrefixFor(markSharedPrefix([], 3, base), base)).toBe(3);
    expect(sharedPrefixFor(markSharedPrefix([], 3, base), [])).toBe(0);
  });
});

describe("a record carrying a change", () => {
  // The comparison decides whether this frame re-copies the record, and the copy
  // is observable: the change must be in the snapshot it produced. Only the
  // change side is pinned — the snapshot also re-copies a record whose live
  // object was replaced, so "same identity" is not a proof of the verdict.
  const frame = (mutate) => {
    const state = freshState();
    state.brackets.forks.a.messages = [{ role: "user", text: "x", extra: [1, 2] }];
    const base = planLedgerEntry(state, null);
    mutate(state.brackets.forks.a);
    markLedgerStructDirty(state.brackets);
    return planLedgerEntry(state, base.brackets).brackets.forks.a;
  };

  test("a real change is still seen", () => {
    expect(frame((record) => {
      record.messages[0].text = "y";
    }).messages[0].text).toBe("y");
    expect(frame((record) => {
      record.messages[0].extra.push(3);
    }).messages[0].extra).toEqual([1, 2, 3]);
  });

  test("the stored copy still holds what JSON can hold", () => {
    const state = freshState();
    state.brackets.forks.a.score = Number.NaN;
    const base = planLedgerEntry(state, null);
    // The comparison must treat a non-finite number as the null JSON stored for
    // it, or the record would be rewritten on every frame for nothing.
    expect(JSON.parse(JSON.stringify(base.brackets.forks.a)).score).toBe(null);
  });
});
