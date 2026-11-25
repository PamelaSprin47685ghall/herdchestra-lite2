// A delivered record body leaves the ledger.
//
// The child's record is read once, when the parent renders the join receipt.
// Keeping it afterwards makes every later baseline re-serialize a transcript
// nobody reads, so a long session's journal grows with its own history squared.
// These cases pin the release, and pin that everything a wake still needs is
// untouched by it.

import { describe, expect, test } from "bun:test";

import {
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
  releaseRecordText,
  serializeLedgerShared,
  takeReady,
} from "../src/scope/forkjoin.mjs";

function ledgerWithChild(recordText = "the child's whole transcript") {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId: "f-1",
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);
  markReady(ledger, "f-1", { record: recordText });
  return ledger;
}

function join(ledger) {
  const taken = takeReady(ledger, { ownerId: "root" });
  expect(taken.ok).toBe(true);
  return taken.fork;
}

describe("a delivered record body is released", () => {
  test("the body is gone from the snapshot while the identity stays", () => {
    const ledger = ledgerWithChild();
    const record = join(ledger);
    expect(record.record).toBe("the child's whole transcript");

    expect(releaseRecordText(ledger, "f-1")).toBe(true);

    const snapshot = serializeLedgerShared(ledger);
    const stored = snapshot.forks["f-1"];
    expect(stored.record).toBeUndefined();
    // What a wake, a restart and a failure report still read.
    expect(stored.fsm).toBe("one state");
    expect(stored.profession).toBe("You are a tester.");
    expect(stored.status).toBe("joined");
  });

  test("a released record stays released through later snapshots", () => {
    const ledger = ledgerWithChild();
    join(ledger);
    releaseRecordText(ledger, "f-1");
    const first = serializeLedgerShared(ledger);
    const second = serializeLedgerShared(ledger);
    expect(second.forks["f-1"].record).toBeUndefined();
    expect(second.forks["f-1"]).toBe(first.forks["f-1"]);
  });

  test("release is refused while the record is still pending", () => {
    const ledger = ledgerWithChild();
    // Ready but not taken: the join receipt has not been rendered yet.
    expect(releaseRecordText(ledger, "f-1")).toBe(false);
    expect(forkOf(ledger, "f-1").record).toBe("the child's whole transcript");
    join(ledger);
  });

  test("release is idempotent and tolerates an unknown fork", () => {
    const ledger = ledgerWithChild();
    join(ledger);
    expect(releaseRecordText(ledger, "f-1")).toBe(true);
    expect(releaseRecordText(ledger, "f-1")).toBe(false);
    expect(releaseRecordText(ledger, "missing")).toBe(false);
  });

  test("a snapshot of a long session does not carry delivered bodies", () => {
    const ledger = createBracketLedger();
    const body = "x".repeat(50_000);
    for (let index = 0; index < 8; index += 1) {
      const forkId = `f-${index}`;
      registerFork(ledger, {
        forkId,
        ownerId: "root",
        fsm: "one state",
        depth: 0,
        budget: { read: 1 },
        profession: "You are a tester.",
      });
      markReady(ledger, forkId, { record: body });
      join(ledger);
      releaseRecordText(ledger, forkId);
    }

    const snapshot = serializeLedgerShared(ledger);
    const serialized = JSON.stringify(snapshot);
    // Eight delivered 50 000-character bodies would be 400 000 characters.
    expect(serialized).not.toContain(body);
    expect(serialized.length).toBeLessThan(20_000);
  });
});
