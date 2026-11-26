// Copy-on-write snapshots of the bracket ledger.
//
// Serializing the ledger used to copy every record on every pass. The cache
// keeps the previous immutable snapshot and rebuilds only the records that
// moved, so an untouched record is the same object in both snapshots.
//
// The proof is identity. A shared record must be `===` across two snapshots,
// an old snapshot must keep its old values after the live ledger moves on, and
// the shared snapshot must still equal a full copy after every single step.

import { describe, expect, test } from "bun:test";

import {
  applyCharge,
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
  serializeLedger,
  serializeLedgerShared,
  takeReady,
} from "../src/scope/forkjoin.mjs";
import { createClockOn, pauseClock } from "../src/scope/clock.mjs";
import { notePanhandled } from "../src/scope/panhandle.mjs";

function running(ledger, forkId, extra = {}) {
  const out = registerFork(ledger, {
    forkId,
    ownerId: "root",
    levelKey: "root|0|0",
    fsm: `work ${forkId}`,
    depth: 0,
    budget: { read: 3 },
    time: 60,
    startedAt: 1_000,
    ...extra,
  });
  expect(out.ok).toBe(true);
  return out.fork;
}

describe("the ledger snapshot is shared, not recopied", () => {
  test("an unchanged ledger hands back the same snapshot", () => {
    const ledger = createBracketLedger();
    running(ledger, "a");
    const first = serializeLedgerShared(ledger);
    expect(serializeLedgerShared(ledger)).toBe(first);
    expect(first).toEqual(serializeLedger(ledger));
  });

  test("a charge copies one record and shares its sibling", () => {
    const ledger = createBracketLedger();
    running(ledger, "a");
    running(ledger, "b");
    const before = serializeLedgerShared(ledger);
    applyCharge(ledger, "a", { tool: "read", toolCallId: "call-1", amount: 1 });
    const after = serializeLedgerShared(ledger);
    expect(after).not.toBe(before);
    expect(after.forks).not.toBe(before.forks);
    expect(after.forks.a).not.toBe(before.forks.a);
    expect(after.forks.b).toBe(before.forks.b);
    expect(before.forks.a.remaining).toEqual({ read: 3 });
    expect(after.forks.a.remaining).toEqual({ read: 2 });
    expect(after).toEqual(serializeLedger(ledger));
  });

  test("a paused clock reaches the next snapshot and no earlier one", () => {
    const ledger = createBracketLedger();
    const record = running(ledger, "a");
    createClockOn(() => 1_000).start(record, 60_000, 1_000);
    const before = serializeLedgerShared(ledger);
    expect(pauseClock(record, 5_000)).toBe(true);
    const after = serializeLedgerShared(ledger);
    expect(before.forks.a.clockPausedAt).toBe(null);
    expect(after.forks.a.clockPausedAt).toBe(5_000);
    expect(after).toEqual(serializeLedger(ledger));
  });

  test("a panhandled call reaches the next snapshot and no earlier one", () => {
    const ledger = createBracketLedger();
    const record = running(ledger, "a");
    const before = serializeLedgerShared(ledger);
    notePanhandled(record, "grep", { now: 2_000, callId: "call-1" });
    const after = serializeLedgerShared(ledger);
    expect(before.forks.a.panhandles).toBeUndefined();
    expect(after.forks.a.panhandles).toEqual([{ at: 2_000, tool: "grep", callId: "call-1" }]);
    expect(after).toEqual(serializeLedger(ledger));
  });

  test("a new fork rebuilds the map and keeps the older records", () => {
    const ledger = createBracketLedger();
    running(ledger, "a");
    const before = serializeLedgerShared(ledger);
    running(ledger, "b");
    const after = serializeLedgerShared(ledger);
    expect(after.forks).not.toBe(before.forks);
    expect(after.forks.a).toBe(before.forks.a);
    expect(after.order).toEqual(["a", "b"]);
    expect(before.order).toEqual(["a"]);
    expect(after).toEqual(serializeLedger(ledger));
  });

  test("a joined branch is copied and the rest of the map is shared", () => {
    const ledger = createBracketLedger();
    running(ledger, "a");
    running(ledger, "b");
    markReady(ledger, "b", { ok: true, record: "done" });
    const before = serializeLedgerShared(ledger);
    const taken = takeReady(ledger, { ownerId: "root", levelKey: "root|0|0" });
    expect(taken.ok).toBe(true);
    const after = serializeLedgerShared(ledger);
    expect(after.forks.b).not.toBe(before.forks.b);
    expect(after.forks.a).toBe(before.forks.a);
    expect(before.forks.b.status).toBe("ready");
    expect(after.forks.b.status).toBe("joined");
    expect(after).toEqual(serializeLedger(ledger));
  });

  test("an old snapshot keeps its values after the live ledger moves on", () => {
    const ledger = createBracketLedger();
    running(ledger, "a");
    const before = serializeLedgerShared(ledger);
    const frozen = JSON.stringify(before);
    running(ledger, "b");
    markReady(ledger, "a", { ok: true, record: "done" });
    takeReady(ledger, { ownerId: "root", levelKey: "root|0|0" });
    applyCharge(ledger, "b", { tool: "read", toolCallId: "call-1", amount: 1 });
    expect(JSON.stringify(before)).toBe(frozen);
  });

  test("a ledger nobody registered still serializes by value", () => {
    const ledger = createBracketLedger();
    running(ledger, "a");
    const raw = structuredClone(serializeLedger(ledger));
    const first = serializeLedgerShared(raw);
    expect(first).toEqual(raw);
    expect(first).not.toBe(raw);
    raw.forks.a.status = "joined";
    expect(first.forks.a.status).toBe("running");
    expect(serializeLedgerShared(raw)).not.toBe(first);
  });

  test("every mutating step keeps the shared snapshot equal to a full copy", () => {
    const ledger = createBracketLedger();
    const same = () => expect(serializeLedgerShared(ledger)).toEqual(serializeLedger(ledger));
    running(ledger, "a");
    same();
    running(ledger, "b");
    same();
    applyCharge(ledger, "a", { tool: "read", toolCallId: "call-1" });
    same();
    pauseClock(forkOf(ledger, "a"), 3_000);
    same();
    notePanhandled(forkOf(ledger, "b"), "bash", { now: 3_500, callId: "call-2" });
    same();
    markReady(ledger, "a", { ok: true, record: "a result" });
    same();
    expect(takeReady(ledger, { ownerId: "root", levelKey: "root|0|0" }).ok).toBe(true);
    same();
    expect(markReady(ledger, "b", { ok: false, reason: "no result" }).ok).toBe(true);
    same();
    expect(takeReady(ledger, { ownerId: "root", levelKey: "root|0|0" }).ok).toBe(true);
    same();
  });
});
