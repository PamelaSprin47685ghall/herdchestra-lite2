// Panhandle and budget grants write through the record door.
//
// Both functions used to mutate the record directly and then call
// `touchRecord` by hand, so the mark was a separate statement a new early
// return could skip. `notePanhandled` had exactly such a return — the duplicate
// admission — and it survived only because someone remembered to compensate for
// the legacy counter seeding above it. These cases drive the real domain
// functions against a real ledger and read what is *still owed* to the journal,
// which is the only thing the mark means.

import { describe, expect, test } from "bun:test";

import { createBracketLedger, registerFork } from "../src/scope/ledger-brackets.mjs";
import { forkOf } from "../src/scope/ledger-charge.mjs";
import { commitPersisted, ledgerPending } from "../src/scope/ledger-cache.mjs";
import { grantBudget, notePanhandled } from "../src/scope/panhandle.mjs";

/** A registered fork whose setup marks have already been acknowledged. */
function seeded(budget = { read: 2 }) {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId: "w",
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget,
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);
  commitPersisted(ledger);
  return { ledger, record: forkOf(ledger, "w") };
}

/** The ids the journal still owes. */
function owed(ledger) {
  return ledgerPending(ledger)?.records ?? [];
}

describe("an admission", () => {
  test("marks the record it wrote", () => {
    const { ledger, record } = seeded();

    const result = notePanhandled(record, "read", { now: 1, callId: "c1" });

    expect(result.ok).toBe(true);
    expect(record.panhandleTotal).toBe(1);
    expect(record.panhandles).toHaveLength(1);
    expect(owed(ledger)).toContain("w");
  });

  test("a duplicate admission marks nothing when it changed nothing", () => {
    const { ledger, record } = seeded();
    notePanhandled(record, "read", { now: 1, callId: "c1" });
    commitPersisted(ledger);
    expect(owed(ledger)).toEqual([]);

    const again = notePanhandled(record, "read", { now: 2, callId: "c1" });

    expect(again).toEqual({ ok: true, count: 1, tool: "read" });
    expect(record.panhandleTotal).toBe(1);
    // Nothing differed, so nothing is owed: a mark here would rewrite the
    // record on every retry of the same call.
    expect(owed(ledger)).toEqual([]);
  });

  test("a duplicate that seeds legacy counters is still persisted", () => {
    const { ledger, record } = seeded();
    // A record from an older snapshot: entries, no counters.
    record.panhandles = [{ at: 1, tool: "read", callId: "c1" }];
    delete record.panhandleTotal;
    delete record.panhandleTools;
    commitPersisted(ledger);

    const result = notePanhandled(record, "read", { now: 2, callId: "c1" });

    expect(result.count).toBe(1);
    expect(record.panhandleTotal).toBe(1);
    expect(record.panhandleTools).toEqual(["read"]);
    // The seeding is a real change even though the admission was a duplicate.
    expect(owed(ledger)).toContain("w");
  });
});

describe("a grant", () => {
  test("adds to the same budget map and marks the record", () => {
    const { ledger, record } = seeded();
    const budget = record.budget;
    const remaining = record.remaining;

    const result = grantBudget(record, { tools: { read: 3 } });

    expect(result.ok).toBe(true);
    expect(result.seconds).toBe(0);
    // The maps the caller already holds are the ones that moved.
    expect(record.budget).toBe(budget);
    expect(record.remaining).toBe(remaining);
    expect(record.budget.read).toBe(5);
    expect(record.remaining.read).toBe(5);
    expect(owed(ledger)).toContain("w");
  });

  test("a refused grant writes nothing at all", () => {
    const { ledger, record } = seeded();
    const before = JSON.stringify(record);

    expect(grantBudget(record, {}).ok).toBe(false);
    expect(grantBudget(record, { tools: { read: 0 } }).ok).toBe(false);
    expect(grantBudget(record, { tools: { read: 1 }, seconds: -1 }).ok).toBe(false);

    expect(JSON.stringify(record)).toBe(before);
    expect(owed(ledger)).toEqual([]);
  });
});
