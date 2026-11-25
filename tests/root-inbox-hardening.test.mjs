// Three ways the closed mailbox could still lose history, each pinned here.
//
// 1. A length write that grows the array leaves a hole no `push` recorded, and
//    the append counter does not move — the snapshot would answer "unchanged".
// 2. A replay append over a ledger whose mailbox is still a plain array must
//    keep that prefix; building an empty container would start the
//    conversation halfway through.
// 3. The clone fallback must serve the mailbox only. Any other value that
//    cannot be cloned has to keep failing rather than be flattened by JSON.

import { describe, expect, test } from "bun:test";

import {
  createState,
  createBracketLedger,
  enqueueRootMessage,
  foldStateChain,
  planLedgerEntry,
  registerFork,
  markLedgerStructDirty,
} from "../src/scope/index.mjs";
import { registerLedger } from "../src/scope/ledger-cache.mjs";
import { applyDelta } from "../src/scope/persistence.mjs";
import {
  adoptInbox,
  createAppendOnlyInbox,
  inboxVersion,
  isAppendOnlyInbox,
} from "../src/scope/append-only-inbox.mjs";

function freshState() {
  const state = createState();
  state.brackets = createBracketLedger();
  registerLedger(state.brackets);
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

function messages(ledger) {
  return (ledger.rootInbox ?? []).map((item) => item.message);
}

describe("a length write", () => {
  test("cannot grow the mailbox into a hole", () => {
    const inbox = createAppendOnlyInbox();
    inbox.push({ message: "one" });
    const before = inboxVersion(inbox);

    expect(() => {
      inbox.length = 2;
    }).toThrow(TypeError);
    expect(() => {
      inbox.length = 999;
    }).toThrow(TypeError);
    expect(inbox).toHaveLength(1);
    // The counter is what a snapshot trusts; a hole would leave it unchanged.
    expect(inboxVersion(inbox)).toBe(before);
    expect(Object.hasOwn(inbox, 1)).toBe(false);
  });

  test("a push still appends, so the counter and the length agree", () => {
    const inbox = createAppendOnlyInbox();
    inbox.push({ message: "one" });
    inbox.push({ message: "two" });
    expect(inbox).toHaveLength(2);
    expect(inboxVersion(inbox)).toBe(2);
  });
});

describe("adopting a ledger's plain array", () => {
  test("keeps the entries it was handed instead of starting empty", () => {
    const inbox = adoptInbox([
      { from: "/", message: "one", envelope: "one" },
      { from: "/", message: "two", envelope: "two" },
    ]);
    expect(isAppendOnlyInbox(inbox)).toBe(true);
    expect(messages({ rootInbox: inbox })).toEqual(["one", "two"]);
    inbox.push({ from: "/", message: "three", envelope: "three" });
    expect(messages({ rootInbox: inbox })).toEqual(["one", "two", "three"]);
  });

  test("an append entry replays on top of a stored mailbox, not over it", () => {
    const state = freshState();
    state.brackets.rootInbox.push({ from: "/", message: "one", envelope: "one" });
    markLedgerStructDirty(state.brackets);
    const base = planLedgerEntry(state, null);

    state.brackets.rootInbox.push({ from: "/", message: "two", envelope: "two" });
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);
    expect(next.entry.rootInboxAppend).toHaveLength(1);

    const restored = foldStateChain([base.entry, next.entry]);
    expect(messages(restored.brackets)).toEqual(["one", "two"]);
    expect(isAppendOnlyInbox(restored.brackets.rootInbox)).toBe(true);
  });
});

describe("the clone fallback", () => {
  test("still refuses a value the journal cannot hold", () => {
    // structuredClone rejects a function. Before the fallback was narrowed this
    // path returned JSON, which silently dropped the field and reported a
    // successful copy.
    const ops = [{ op: "set", path: ["value"], value: { keep: "text", run: () => 1 } }];
    expect(() => applyDelta({ value: null }, ops)).toThrow();
  });

  test("copies an object that merely holds an inbox", () => {
    const ledger = { rootInbox: adoptInbox([{ message: "one" }]) };
    const copy = applyDelta(ledger, [
      { op: "set", path: ["note"], value: "kept" },
    ]);
    expect(copy.note).toBe("kept");
    expect(copy.rootInbox).toEqual([{ message: "one" }]);
    expect(isAppendOnlyInbox(copy.rootInbox)).toBe(false);
  });
});
