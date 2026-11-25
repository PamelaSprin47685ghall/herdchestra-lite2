import { describe, expect, test } from "bun:test";
import { createBracketLedger, registerFork, snapshotForkChanges } from "../src/scope/forkjoin.mjs";

function add(ledger, forkId) {
  const result = registerFork(ledger, { forkId, ownerId: "root", fsm: "work", depth: 0, budget: { read: 1 }, profession: "You are a tester." });
  expect(result.ok).toBe(true);
  return result.fork;
}

describe("snapshotForkChanges", () => {
  test("copies only requested records and captures deletions", () => {
    const ledger = createBracketLedger();
    const first = add(ledger, "first");
    add(ledger, "other");
    first.targets = ["original"];
    const result = snapshotForkChanges(ledger, ["first", "deleted", "first"]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.set)).toEqual(["first"]);
    expect(result.del).toEqual(["deleted"]);
    first.targets.push("later");
    expect(result.set.first.targets).toEqual(["original"]);
  });

  test("refuses an invalid record instead of deleting it", () => {
    const ledger = createBracketLedger();
    add(ledger, "first").forkId = "wrong";
    expect(snapshotForkChanges(ledger, ["first"])).toEqual({ ok: false, reason: "invalid-record", forkId: "first" });
  });

  test("never enumerates unrelated records", () => {
    const ledger = createBracketLedger();
    add(ledger, "first");
    ledger.forks = new Proxy(ledger.forks, { ownKeys() { throw new Error("full scan"); } });
    expect(snapshotForkChanges(ledger, ["first"]).ok).toBe(true);
  });
});
