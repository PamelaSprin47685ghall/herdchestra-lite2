// The inbox cursor must be on disk before the child is prompted — driven
// through the real spawn ticket, not a re-enactment of its steps.
//
// `deliverInbox` reads the branch's mailbox, advances `inboxDelivered`, and then
// awaits the prompt. Between that write and the child's first turn a persistence
// pass can run. If the record was not marked, that pass reuses the copy it
// already had and the journal keeps the old cursor; on restart the branch then
// re-reads envelopes it has already answered — duplicated instructions to a
// working agent.
//
// `tests/spawn-inbox-cursor.test.mjs` asserts the same property by replaying
// the three steps itself, so it cannot notice the ticket reordering them. This
// suite drives `spawnChildTicket` and captures the journal from inside the
// prompt it awaits: that is the only place the ordering is observable.

import { describe, expect, test } from "bun:test";

import {
  createBracketLedger,
  foldStateChain,
  markReady,
  planLedgerEntry,
  registerFork,
} from "../src/scope/index.mjs";
import { enqueueScopeMessage, forkOf } from "../src/scope/forkjoin.mjs";
import { registerLedger } from "../src/scope/ledger-cache.mjs";
import { createForkRegistry } from "../src/scope/fork-registry.mjs";
import { spawnChildTicket } from "../src/tools/spawn-ticket.mjs";

const FORK_ID = "f-1";

/** A journal with one live fork and two delivered-but-unread envelopes. */
function seededJournal() {
  const ledger = createBracketLedger();
  registerLedger(ledger);
  const registered = registerFork(ledger, {
    forkId: FORK_ID,
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);

  enqueueScopeMessage(ledger, FORK_ID, {
    from: "/",
    message: "first requirement",
    envelope: "requirement one",
  });
  enqueueScopeMessage(ledger, FORK_ID, {
    from: "/",
    message: "second requirement",
    envelope: "requirement two",
  });

  // `ready`, not `running`: the ticket then delivers the inbox exactly once and
  // skips the return-nudge loop, so this test observes one await and no nudges.
  markReady(ledger, FORK_ID, { ok: true, record: "waiting for work" });
  return ledger;
}

/**
 * Drive the real ticket, snapshotting the journal from inside the prompt it
 * awaits. Returns what a reload would see, plus the intermediate evidence.
 */
async function drive() {
  const ledger = seededJournal();
  const state = { brackets: ledger };
  const entries = [];

  // The durable baseline the live anchor would already have written.
  const base = planLedgerEntry(state, null);
  expect(base.entry).toBeTruthy();
  entries.push(base.entry);

  const receipt = "read the brief, then work";
  const prompts = [];
  let liveAtDelivery = null;
  let entryDuringDelivery = null;

  const session = {
    getAgentId: () => "agent-child",
    agent: { state: { messages: [] } },
    async prompt(text) {
      prompts.push(text);
      if (!text.includes("requirement one")) return;
      // Mid-await: the cursor was advanced and marked, and the prompt has not
      // returned. Anything the domain wrote must already be in the journal.
      liveAtDelivery = forkOf(ledger, FORK_ID)?.inboxDelivered ?? null;
      const plan = planLedgerEntry(state, base.brackets);
      if (plan.entry) {
        entryDuringDelivery = plan.entry;
        entries.push(plan.entry);
      }
    },
  };

  const registry = createForkRegistry();
  await spawnChildTicket(
    { forkId: FORK_ID, receipt },
    {
      registry,
      ledger,
      createSession: async () => ({
        ok: true,
        session,
        agentId: "agent-child",
      }),
      // Everything else is optional to the ticket; a bare port object keeps the
      // host out of this test without changing the code path under test.
      persistLedger: () => {},
    },
  );

  return { base, entries, prompts, receipt, liveAtDelivery, entryDuringDelivery, ledger };
}

function reloaded(entries) {
  const folded = foldStateChain(entries);
  return folded === null ? null : folded.brackets.forks[FORK_ID];
}

describe("the inbox cursor survives the prompt the ticket awaits", () => {
  test("the receipt is prompted before any inbox delivery", async () => {
    const { prompts, receipt, ledger } = await drive();
    expect(prompts[0]).toBe(receipt);
    expect(prompts.length).toBeGreaterThan(1);
    // Both envelopes travel in one prompt, in arrival order, joined by a blank
    // line — the shape the child reads as consecutive instructions. The
    // expected text is taken from the record, so this asserts the delivery
    // contract (order and joining) rather than how an envelope is encoded.
    const expected = forkOf(ledger, FORK_ID).inbox
      .map((entry) => entry.envelope)
      .join("\n\n");
    expect(prompts[1]).toBe(expected);
    expect(forkOf(ledger, FORK_ID).inbox.length).toBe(2);
  });

  test("the cursor is already advanced when the prompt is in flight", async () => {
    const { liveAtDelivery } = await drive();
    // Read from inside the await, so this is the state a concurrent persistence
    // pass would see — not a value reconstructed afterwards.
    expect(liveAtDelivery).toBe(2);
  });

  test("a pass landing during the await owes the cursor, and writing it survives reload", async () => {
    const { entryDuringDelivery, entries } = await drive();

    // Something was owed during the await; without it the journal never learns
    // the branch read its mail.
    expect(entryDuringDelivery).not.toBeNull();
    const patches = entryDuringDelivery.patches;
    // The record travels as a field diff now, so the cursor is named by an op
    // rather than by a whole copied record. The reload below is what proves the
    // value arrives.
    expect(JSON.stringify(patches?.[FORK_ID] ?? null)).toContain("inboxDelivered");

    const restored = reloaded(entries);
    expect(restored).not.toBeNull();
    expect(restored.inboxDelivered).toBe(2);
    // The envelopes themselves stay readable for an audit.
    expect(restored.inbox.map((item) => item.message)).toEqual([
      "first requirement",
      "second requirement",
    ]);
  });

  test("the entry captured during the await is load-bearing, not incidental", async () => {
    const { base, entries } = await drive();

    // Fold the baseline alone: the cursor stays where it was.
    expect(reloaded([base.entry]).inboxDelivered).toBe(0);
    // Add the one entry a pass in flight produced: the cursor is there.
    expect(reloaded(entries).inboxDelivered).toBe(2);
    // Same journal, one entry apart — so the difference is that entry.
    expect(entries.length).toBe(2);
  });

  test("the ticket advances the cursor once for both envelopes", async () => {
    const { ledger, entries } = await drive();

    // The live record and the reloaded journal agree, so no delivery is lost
    // between them and none is counted twice.
    expect(forkOf(ledger, FORK_ID).inboxDelivered).toBe(2);
    expect(reloaded(entries).inboxDelivered).toBe(2);
    expect(reloaded(entries).inbox.length).toBe(2);
  });
});
