// The root mailbox is append-only, and the journal must name only what was
// appended.
//
// Two costs lived in this decision. The first was the copy: a whole-list head
// would restate every message on every write, so a long session paid its own
// history per write. The second was the proof: deciding "is this still the
// prefix I stored" by serialising every message cost the history in bytes on
// every write even when nothing had been appended.
//
// The prefix is now proven by identity first — a root envelope is written once
// and never edited, so the same object at the same position is the same
// message — and only a fresh object falls back to the value comparison. These
// cases pin the three shapes that decision must get right, including the one a
// cheap identity check alone would get wrong: a rebuilt envelope with equal
// contents is still a prefix, not a rewrite.
//
// The arithmetic is driven through the production planners, and every result is
// checked by folding the journal the way a reload does, so a lost message shows
// up as a shorter mailbox rather than as a wrong field.

import { describe, expect, test } from "bun:test";

import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  foldStateChain,
  markLedgerStructDirty,
} from "../src/scope/index.mjs";

function freshState() {
  const state = createState();
  state.brackets = createBracketLedger();
  return state;
}

function fork(state, forkId) {
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

function envelope(message) {
  return { from: "/worker", message, envelope: message };
}

/** What a reload reads: the mailbox the journal actually holds. */
function mailbox(entries) {
  const folded = foldStateChain(entries.filter(Boolean));
  return folded === null ? null : folded.brackets.rootInbox.map((item) => item.message);
}

describe("appending to the root mailbox", () => {
  test("one appended message costs one message, not the mailbox", () => {
    const state = freshState();
    fork(state, "a");
    const base = planLedgerEntry(state, null);
    expect(base.entry.full).toBe(true);

    // Three appends in place, the way the send path writes them.
    state.brackets.rootInbox.push(envelope("one"));
    markLedgerStructDirty(state.brackets);
    const first = planLedgerEntry(state, base.brackets);
    state.brackets.rootInbox.push(envelope("two"));
    markLedgerStructDirty(state.brackets);
    const second = planLedgerEntry(state, first.brackets);

    expect(first.entry.rootInboxAppend).toHaveLength(1);
    expect(first.entry.rootInbox).toBeUndefined();
    expect(second.entry.rootInboxAppend).toHaveLength(1);
    expect(second.entry.rootInbox).toBeUndefined();

    expect(mailbox([base.entry, first.entry, second.entry])).toEqual(["one", "two"]);
  });

  test("repeated identical messages keep their turns in the journal", () => {
    const state = freshState();
    fork(state, "a");
    const base = planLedgerEntry(state, null);
    const entries = [base.entry];
    let previous = base.brackets;

    // The same text twice: an append-only list must not deduplicate, or the
    // second delivery would vanish on reload.
    for (const message of ["again", "again", "third"]) {
      state.brackets.rootInbox.push(envelope(message));
      markLedgerStructDirty(state.brackets);
      const plan = planLedgerEntry(state, previous);
      expect(plan.entry.rootInboxAppend).toHaveLength(1);
      entries.push(plan.entry);
      previous = plan.brackets;
    }

    expect(mailbox(entries)).toEqual(["again", "again", "third"]);
  });

  test("a rebuilt envelope with equal contents is still a prefix", () => {
    const state = freshState();
    fork(state, "a");
    state.brackets.rootInbox.push(envelope("kept"));
    markLedgerStructDirty(state.brackets);
    const base = planLedgerEntry(state, null);

    // A restore, a replay, or a copy rebuilds the envelope: the object is new,
    // its contents are the same. Identity alone would call this a rewrite and
    // restate the whole mailbox; the value fallback must call it a prefix.
    state.brackets.rootInbox = [envelope("kept"), envelope("new")];
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    expect(next.entry.rootInbox).toBeUndefined();
    expect(next.entry.rootInboxAppend).toHaveLength(1);
    expect(next.entry.rootInboxAppend[0].message).toBe("new");
    expect(mailbox([base.entry, next.entry])).toEqual(["kept", "new"]);
  });

  test("a rewritten earlier message restates the mailbox instead of dropping it", () => {
    const state = freshState();
    fork(state, "a");
    state.brackets.rootInbox.push(envelope("original"));
    state.brackets.rootInbox.push(envelope("tail"));
    markLedgerStructDirty(state.brackets);
    const base = planLedgerEntry(state, null);

    // Contents differ: this is not an append, and the entry must carry the
    // whole list. Writing a suffix here would keep the stale message.
    state.brackets.rootInbox = [envelope("edited"), envelope("tail"), envelope("added")];
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    expect(next.entry.rootInboxAppend).toBeUndefined();
    expect(next.entry.rootInbox).toHaveLength(3);
    expect(mailbox([base.entry, next.entry])).toEqual(["edited", "tail", "added"]);
  });

  test("a shrinking mailbox is restated, never replayed as an append", () => {
    const state = freshState();
    fork(state, "a");
    state.brackets.rootInbox.push(envelope("one"));
    state.brackets.rootInbox.push(envelope("two"));
    markLedgerStructDirty(state.brackets);
    const base = planLedgerEntry(state, null);

    state.brackets.rootInbox = [envelope("one")];
    markLedgerStructDirty(state.brackets);
    const next = planLedgerEntry(state, base.brackets);

    expect(next.entry.rootInboxAppend).toBeUndefined();
    expect(next.entry.rootInbox).toHaveLength(1);
    expect(mailbox([base.entry, next.entry])).toEqual(["one"]);
  });

  test("an unchanged mailbox writes nothing", () => {
    const state = freshState();
    fork(state, "a");
    state.brackets.rootInbox.push(envelope("quiet"));
    markLedgerStructDirty(state.brackets);
    const base = planLedgerEntry(state, null);

    const quiet = planLedgerEntry(state, base.brackets);
    expect(quiet.entry).toBeNull();
  });
});
