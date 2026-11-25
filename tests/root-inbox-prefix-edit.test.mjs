// The journal may append a suffix only when everything before it is still what
// was stored. That is a property of the mailbox object, not a promise in a
// comment: the mailbox refuses every write except `push`, and it freezes each
// entry it stores. A write through a delivered entry therefore fails at the
// write instead of being reused as an unread prefix and dropped without a word.
//
// These cases pin the refusal, and pin that the paths that must still work —
// append, reload, replay, two consumers — keep working.

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
}

function deliver(state, message) {
  state.brackets.rootInbox.push({ from: "/api", message, envelope: message });
  markLedgerStructDirty(state.brackets);
}

function messages(ledger) {
  return (ledger.rootInbox ?? []).map((item) => item.message);
}

/** The stored message list after replaying every accepted entry in order. */
function replay(entries) {
  return messages(foldStateChain(entries).brackets);
}

describe("a write through a delivered entry", () => {
  test("replacing a field raises instead of being silently lost", () => {
    const state = freshState();
    register(state, "a");
    for (const text of ["one", "two", "three"]) deliver(state, text);

    expect(() => {
      state.brackets.rootInbox[0].message = "one-corrected";
    }).toThrow(TypeError);
    expect(messages(state.brackets)).toEqual(["one", "two", "three"]);
  });

  test("editing a field in the middle raises as well", () => {
    const state = freshState();
    register(state, "a");
    for (const text of ["one", "two", "three"]) deliver(state, text);

    expect(() => {
      state.brackets.rootInbox[1].message = "two-corrected";
    }).toThrow(TypeError);
    expect(messages(state.brackets)).toEqual(["one", "two", "three"]);
  });

  test("reordering, deleting or truncating the mailbox raises", () => {
    const state = freshState();
    register(state, "a");
    for (const text of ["one", "two"]) deliver(state, text);
    const inbox = state.brackets.rootInbox;

    expect(() => inbox.reverse()).toThrow(TypeError);
    expect(() => inbox.sort()).toThrow(TypeError);
    expect(() => inbox.splice(0, 1)).toThrow(TypeError);
    expect(() => inbox.pop()).toThrow(TypeError);
    expect(() => inbox.shift()).toThrow(TypeError);
    expect(() => {
      inbox.length = 0;
    }).toThrow(TypeError);
    expect(() => {
      delete inbox[0];
    }).toThrow(TypeError);
    expect(messages(state.brackets)).toEqual(["one", "two"]);
  });

  test("a fresh array assigned to the field is adopted, not trusted", () => {
    const state = freshState();
    register(state, "a");
    for (const text of ["one", "two"]) deliver(state, text);
    const base = planLedgerEntry(state, null);

    // Assigning a different array is the documented way to say "the mailbox is
    // now this". The snapshot compares it by content, so the rewrite is stored
    // whole rather than reused as an append.
    state.brackets.rootInbox = [{ from: "/", message: "b", envelope: "b" }];
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    expect(next.refused).toBeUndefined();
    expect(next.entry.rootInboxAppend).toBeUndefined();
    expect(next.entry.rootInbox.map((item) => item.message)).toEqual(["b"]);
    expect(replay([base.entry, next.entry])).toEqual(["b"]);
  });
});

describe("an edit before the appended tail", () => {
  test("an append after a refused edit stores only the new tail", () => {
    const state = freshState();
    register(state, "a");
    for (const text of ["one", "two", "three"]) deliver(state, text);
    const base = planLedgerEntry(state, null);

    expect(() => {
      state.brackets.rootInbox[0].message = "one-corrected";
    }).toThrow(TypeError);
    deliver(state, "four");
    const next = planLedgerEntry(state, base.brackets);

    expect(next.refused).toBeUndefined();
    expect(next.entry.rootInbox).toBeUndefined();
    expect(next.entry.rootInboxAppend.map((item) => item.message)).toEqual(["four"]);
    expect(replay([base.entry, next.entry])).toEqual(["one", "two", "three", "four"]);
  });

  test("a long mailbox keeps its history and appends the tail", () => {
    const state = freshState();
    register(state, "a");
    const count = 500;
    for (let index = 0; index < count; index += 1) deliver(state, `m${index}`);
    const base = planLedgerEntry(state, null);

    expect(() => {
      state.brackets.rootInbox[137].message = "edited";
    }).toThrow(TypeError);
    deliver(state, "tail");
    const next = planLedgerEntry(state, base.brackets);

    expect(next.entry.rootInboxAppend.map((item) => item.message)).toEqual(["tail"]);
    const stored = replay([base.entry, next.entry]);
    expect(stored).toHaveLength(count + 1);
    expect(stored[137]).toBe("m137");
    expect(stored[136]).toBe("m136");
    expect(stored[138]).toBe("m138");
    expect(stored[count]).toBe("tail");
  });
});

describe("two consumers reading the same ledger", () => {
  test("a clean append reaches both, and each replays its own chain", () => {
    const state = freshState();
    register(state, "a");
    for (const text of ["one", "two"]) deliver(state, text);

    // Two independent journals, each with its own idea of what it stored.
    const firstLoad = planLedgerEntry(state, null);
    const secondLoad = planLedgerEntry(state, null);
    expect(firstLoad.entry.full).toBe(true);

    deliver(state, "three");
    const firstNext = planLedgerEntry(state, firstLoad.brackets);
    const secondNext = planLedgerEntry(state, secondLoad.brackets);

    for (const next of [firstNext, secondNext]) {
      expect(next.refused).toBeUndefined();
      expect(next.entry.rootInbox).toBeUndefined();
      expect(next.entry.rootInboxAppend.map((item) => item.message)).toEqual(["three"]);
    }

    expect(replay([firstLoad.entry, firstNext.entry])).toEqual(["one", "two", "three"]);
    expect(replay([secondLoad.entry, secondNext.entry])).toEqual(["one", "two", "three"]);
  });

  test("a consumer that has fallen behind still receives only its own suffix", () => {
    const state = freshState();
    register(state, "a");
    deliver(state, "one");
    const behind = planLedgerEntry(state, null);

    deliver(state, "two");
    const ahead = planLedgerEntry(state, behind.brackets);
    deliver(state, "three");

    // The lagging consumer's baseline holds "one"; the array has "three" now.
    const caughtUp = planLedgerEntry(state, behind.brackets);
    expect(caughtUp.entry.rootInboxAppend.map((item) => item.message)).toEqual([
      "two",
      "three",
    ]);
    expect(replay([behind.entry, caughtUp.entry])).toEqual(["one", "two", "three"]);

    // The consumer already at "two" appends only "three".
    const fromAhead = planLedgerEntry(state, ahead.brackets);
    expect(fromAhead.entry.rootInboxAppend.map((item) => item.message)).toEqual(["three"]);
  });
});
