import { describe, test, expect } from "bun:test";
import {
  createBracketLedger,
  enqueueRootMessage,
  markLedgerStructDirty,
  serializeLedger,
  serializeLedgerShared,
} from "../src/scope/forkjoin.mjs";

// The root mailbox is where a long root-level conversation lives, and the
// snapshot runs on every structural change — a new root message is one. The
// snapshot must therefore share the copies of entries that were already
// stored, and copy only the tail. These cases pin that, and pin that the
// array-replacement paths keep their old whole-list behaviour.

describe("the snapshot of the root mailbox", () => {
  test("reuses the stored copies of an appended mailbox and copies only the tail", () => {
    const ledger = createBracketLedger();
    for (const text of ["one", "two", "three"]) enqueueRootMessage(ledger, { message: text });
    const first = serializeLedgerShared(ledger);

    enqueueRootMessage(ledger, { message: "four" });
    const second = serializeLedgerShared(ledger);

    expect(second.rootInbox.map((entry) => entry.message)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    // The reused prefix is the very same copies, so no entry was re-read.
    expect(second.rootInbox[0]).toBe(first.rootInbox[0]);
    expect(second.rootInbox[2]).toBe(first.rootInbox[2]);
    expect(second.rootInbox[3]).not.toBe(first.rootInbox[3]);
    // The previous snapshot is untouched: persistence compares the two lists,
    // and a copy that grew in place would erase the append it must report.
    expect(first.rootInbox).toHaveLength(3);
  });

  test("a snapshot with nothing appended leaves the mailbox array alone", () => {
    const ledger = createBracketLedger();
    enqueueRootMessage(ledger, { message: "one" });
    const first = serializeLedgerShared(ledger);

    markLedgerStructDirty(ledger);
    const second = serializeLedgerShared(ledger);
    expect(second.rootInbox).toBe(first.rootInbox);
  });

  test("a replaced array is copied whole, so a reorder is still observed", () => {
    const ledger = createBracketLedger();
    enqueueRootMessage(ledger, { message: "one" });
    enqueueRootMessage(ledger, { message: "two" });
    const first = serializeLedgerShared(ledger);

    ledger.rootInbox = [ledger.rootInbox[1], ledger.rootInbox[0]];
    const second = serializeLedgerShared(ledger);

    expect(second.rootInbox.map((entry) => entry.message)).toEqual(["two", "one"]);
    expect(second.rootInbox[0]).not.toBe(first.rootInbox[1]);
  });

  test("a shortened array falls back to a copy instead of keeping stale entries", () => {
    const ledger = createBracketLedger();
    enqueueRootMessage(ledger, { message: "one" });
    enqueueRootMessage(ledger, { message: "two" });
    const first = serializeLedgerShared(ledger);

    ledger.rootInbox = [];
    const second = serializeLedgerShared(ledger);
    expect(second.rootInbox).toEqual([]);
    expect(first.rootInbox).toHaveLength(2);
  });

  test("the copies stay JSON-safe, so what is stored is what a load can hold", () => {
    const ledger = createBracketLedger();
    enqueueRootMessage(ledger, { message: "one" });
    ledger.rootInbox.push({ from: "/a", envelope: "one", extra: () => 1 });
    const first = serializeLedgerShared(ledger);
    enqueueRootMessage(ledger, { message: "two" });
    const second = serializeLedgerShared(ledger);

    expect(() => JSON.stringify(second)).not.toThrow();
    expect(JSON.parse(JSON.stringify(second.rootInbox))).toEqual(
      JSON.parse(JSON.stringify(serializeLedger(ledger).rootInbox)),
    );
  });

  test("a mailbox that no snapshot has seen yet is copied whole", () => {
    const ledger = createBracketLedger();
    enqueueRootMessage(ledger, { message: "one" });
    const snapshot = serializeLedgerShared(ledger);
    expect(snapshot.rootInbox).toHaveLength(1);
    expect(snapshot.rootInbox[0]).toEqual({ from: "/", message: "one", envelope: "[Message from /]\none" });
  });
});
