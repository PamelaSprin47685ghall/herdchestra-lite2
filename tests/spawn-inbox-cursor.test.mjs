// The inbox cursor must be on disk before the child is prompted.
//
// `deliverInbox` reads the branch's mailbox, advances `inboxDelivered`, and then
// awaits the prompt. Between that write and the child's first turn, a
// persistence pass can run. If the record was not marked, that pass reuses the
// copy it already had, and the journal keeps the old cursor. On restart the
// branch then re-reads envelopes it has already answered — duplicated
// instructions to a working agent, which is worse than a slow write.
//
// These cases drive the real domain functions and the real planner, so the
// assertion is about what a reload would see, not about an internal flag.

import { describe, expect, test } from "bun:test";

import {
  createBracketLedger,
  createState,
  foldStateChain,
  registerFork,
} from "../src/scope/index.mjs";
import { touchFork, enqueueScopeMessage } from "../src/scope/forkjoin.mjs";
import { planLedgerEntry } from "../src/scope/persistence.mjs";
import { markRecordDirty, commitPersisted } from "../src/scope/ledger-cache.mjs";

function stateWithFork(forkId = "f-1") {
  const state = createState();
  state.brackets = createBracketLedger();
  const registered = registerFork(state.brackets, {
    forkId,
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);
  return state;
}

function addMessage(state, forkId, text) {
  const record = state.brackets.forks[forkId];
  const outcome = enqueueScopeMessage
    ? enqueueScopeMessage(state.brackets, forkId, {
        from: "/",
        message: text,
        envelope: { message: text },
      })
    : null;
  if (!outcome) {
    // Fall back to the shape the domain function writes.
    record.inbox.push({ from: "/", message: text, envelope: { message: text } });
    markRecordDirty(state.brackets, forkId);
  }
}

/** What a reload of this journal sees for the fork. */
function reloaded(entries) {
  const folded = foldStateChain(entries);
  return folded === null ? null : folded.brackets.forks["f-1"];
}

describe("the inbox cursor survives the prompt await", () => {
  test("advancing the cursor is persisted by a pass during the await", () => {
    const state = stateWithFork();
    addMessage(state, "f-1", "first requirement");
    addMessage(state, "f-1", "second requirement");

    const base = planLedgerEntry(state, null);
    expect(base.entry).toBeTruthy();
    const entries = [base.entry];

    const record = state.brackets.forks["f-1"];
    expect(record.inbox.length).toBe(2);
    expect(record.inboxDelivered).toBe(0);

    // The exact sequence `deliverInbox` performs before it awaits the prompt.
    record.inboxDelivered = record.inbox.length;
    touchFork(state.brackets, "f-1");

    // A persistence pass landing while the prompt is in flight.
    const during = planLedgerEntry(state, base.brackets);
    expect(during.entry, "the cursor change must reach the journal").toBeTruthy();
    entries.push(during.entry);

    const restored = reloaded(entries);
    expect(restored.inboxDelivered).toBe(2);
    // And the envelopes themselves are still readable for an audit.
    expect(restored.inbox.map((item) => item.message)).toEqual([
      "first requirement",
      "second requirement",
    ]);
  });

  test("an unmarked cursor write still reaches the journal", () => {
    // The case that used to be the counter-proof: a write that skips
    // `touchFork` would be silent if only the mark decided what got stored —
    // the journal stays self-consistent and never learns the branch has read
    // its mail. The content comparison closes that hole.
    const state = stateWithFork();
    addMessage(state, "f-1", "first requirement");
    addMessage(state, "f-1", "second requirement");

    const base = planLedgerEntry(state, null);
    const entries = [base.entry];
    // The baseline is accepted before the cursor moves, so the record is not
    // already owed: the envelope marks from `addMessage` must not stand in for
    // the delivery mark, or the case would pass for the wrong reason.
    commitPersisted(state.brackets);

    const record = state.brackets.forks["f-1"];
    record.inboxDelivered = record.inbox.length;
    // No touchFork here.

    const during = planLedgerEntry(state, base.brackets);
    if (during.entry) entries.push(during.entry);

    const restored = reloaded(entries);
    // The mark is not what makes the cursor durable. The snapshot compares a
    // record's content before it reuses a copy, so an alias write that skipped
    // `touchFork` still reaches the journal — correctness comes from the
    // comparison, and the mark only keeps the comparison cheap. The value must
    // not be lost: that, not the old cursor, is the failure worth guarding.
    expect(restored.inboxDelivered).toBe(2);
  });

  test("a cursor advanced twice keeps the latest value", () => {
    const state = stateWithFork();
    addMessage(state, "f-1", "first");
    const base = planLedgerEntry(state, null);
    const entries = [base.entry];
    let previous = base.brackets;

    // First delivery.
    let record = state.brackets.forks["f-1"];
    record.inboxDelivered = record.inbox.length;
    touchFork(state.brackets, "f-1");
    let plan = planLedgerEntry(state, previous);
    expect(plan.entry).toBeTruthy();
    entries.push(plan.entry);
    previous = plan.brackets;

    // A new requirement arrives and is delivered in the next turn.
    addMessage(state, "f-1", "second");
    record = state.brackets.forks["f-1"];
    record.inboxDelivered = record.inbox.length;
    touchFork(state.brackets, "f-1");
    plan = planLedgerEntry(state, previous);
    expect(plan.entry).toBeTruthy();
    entries.push(plan.entry);

    const restored = reloaded(entries);
    expect(restored.inboxDelivered).toBe(2);
    expect(restored.inbox.length).toBe(2);
  });
});
