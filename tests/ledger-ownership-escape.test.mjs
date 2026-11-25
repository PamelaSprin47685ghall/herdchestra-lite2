import { describe, expect, test } from "bun:test";
import { createBracketLedger, registerFork, forkOf, markReady, takeReady, enqueueScopeMessage, takePendingInbox, serializeLedgerShared, restoreLedgerChecked } from "../src/scope/forkjoin.mjs";

function seeded() {
  const ledger = createBracketLedger();
  const result = registerFork(ledger, {
    forkId: "child", ownerId: "root", fsm: "work", depth: 0,
    budget: { read: 2 }, profession: "You are a tester.",
  });
  expect(result.ok).toBe(true);
  return { ledger, record: result.fork };
}

describe("ledger record ownership boundary", () => {
  test("fork lookup returns the registered fork identity", () => {
    const { ledger } = seeded();
    expect(forkOf(ledger, "child").forkId).toBe("child");
    expect(ledger.forks.child.forkId).toBe("child");
  });

  test("nested writes, deletes and array updates are reflected in later snapshots", () => {
    const { ledger, record } = seeded();
    record.inbox.push({ from: "/", envelope: "first" });
    const first = serializeLedgerShared(ledger);
    record.inbox[0].envelope = "edited";
    const second = serializeLedgerShared(ledger);
    expect(second.forks.child.inbox[0].envelope).toBe("edited");
    expect(first.forks.child.inbox[0].envelope).toBe("first");
    delete record.budget.read;
    const third = serializeLedgerShared(ledger);
    expect(Object.hasOwn(third.forks.child.budget, "read")).toBe(false);
    record.inbox.length = 0;
    expect(serializeLedgerShared(ledger).forks.child.inbox).toEqual([]);
  });

  test("restored records also track nested writes", () => {
    const { ledger } = seeded();
    const restored = restoreLedgerChecked(serializeLedgerShared(ledger));
    expect(restored.ok).toBe(true);
    serializeLedgerShared(restored.ledger);
    forkOf(restored.ledger, "child").budget.read = 9;
    expect(serializeLedgerShared(restored.ledger).forks.child.budget.read).toBe(9);
  });

  test("a non-configurable object field remains readable", () => {
    const { record } = seeded();
    const value = { note: "kept" };
    Object.defineProperty(record, "locked", {
      value, writable: false, configurable: false, enumerable: true,
    });
    expect(record.locked).toBe(value);
    expect(record.locked.note).toBe("kept");
  });

  test("registered records support structured cloning", () => {
    const { record } = seeded();
    const copy = structuredClone(record);
    expect(copy.forkId).toBe("child");
    expect(copy.budget.read).toBe(2);
  });

  test("mutating an assigned object through its original reference reaches the snapshot", () => {
    const { ledger, record } = seeded();
    const budget = { read: 2 };
    record.budget = budget;
    serializeLedgerShared(ledger);
    budget.read = 7;
    expect(record.budget.read).toBe(7);
    expect(serializeLedgerShared(ledger).forks.child.budget.read).toBe(7);
  });

  test("an unmarked replacement and a removal both reach the next snapshot", () => {
    const { ledger, record } = seeded();
    const before = serializeLedgerShared(ledger);
    record.budget = { read: 8 };
    const after = serializeLedgerShared(ledger);
    expect(before.forks.child.budget.read).toBe(2);
    expect(after.forks.child.budget.read).toBe(8);
    delete ledger.forks.child;
    ledger.order.length = 0;
    const removed = serializeLedgerShared(ledger);
    expect(Object.keys(removed.forks)).toEqual([]);
  });

  test("an inbox entry returned for delivery remains a live alias", () => {
    const { ledger } = seeded();
    expect(enqueueScopeMessage(ledger, "child", {
      from: "/", message: "initial", envelope: "initial",
    }).ok).toBe(true);
    const entries = takePendingInbox(ledger, "child");
    expect(entries).toHaveLength(1);
    const before = serializeLedgerShared(ledger);
    entries[0].message = "edited after delivery";
    const after = serializeLedgerShared(ledger);
    expect(before.forks.child.inbox[0].message).toBe("initial");
    expect(after.forks.child.inbox[0].message).toBe("edited after delivery");
  });

  test("clock collaborator may retain a live nested budget alias", () => {
    const ledger = createBracketLedger();
    let retained;
    const result = registerFork(ledger, {
      forkId: "child", ownerId: "root", fsm: "work", depth: 0,
      budget: { read: 2 }, profession: "You are a tester.",
    }, { clock: { start(record) { retained = record.budget; } } });
    expect(result.ok).toBe(true);
    const before = serializeLedgerShared(ledger);
    retained.read = 7;
    expect(forkOf(ledger, "child").budget.read).toBe(7);
    expect(serializeLedgerShared(ledger).forks.child.budget.read).toBe(7);
    expect(before.forks.child.budget.read).toBe(2);
  });

  test("join admission callback may retain the live record", () => {
    const { ledger } = seeded();
    expect(markReady(ledger, "child").ok).toBe(true);
    let retained;
    expect(takeReady(ledger, {
      ownerId: "root",
      admit(record) { retained = record; return { ok: false }; },
    }).code).toBe("NO_ADMISSIBLE_CHILD");
    const before = serializeLedgerShared(ledger);
    retained.budget.read = 9;
    expect(serializeLedgerShared(ledger).forks.child.budget.read).toBe(9);
    expect(before.forks.child.budget.read).toBe(2);
  });

  test("record getters are read again when the changed record is copied", () => {
    const { ledger, record } = seeded();
    serializeLedgerShared(ledger);
    let reads = 0;
    Object.defineProperty(record, "task", {
      configurable: true,
      enumerable: true,
      get() { return `observed-${++reads}`; },
    });
    const snapshot = serializeLedgerShared(ledger);
    // The inspected copy and the resulting record copy are separate reads.
    // Reusing the first would change both the getter effects and the value.
    expect(reads).toBe(2);
    expect(snapshot.forks.child.task).toBe("observed-2");
  });

  test("an accepted nested write is visible to the next snapshot", () => {
    const { ledger, record } = seeded();
    serializeLedgerShared(ledger);
    try {
      record.budget.read = 7;
    } catch (error) {
      // A read-only view is also valid: rejecting the write makes it impossible
      // for in-memory state to diverge silently from a persisted snapshot.
      expect(error).toBeInstanceOf(TypeError);
      expect(ledger.forks.child.budget.read).toBe(2);
      return;
    }
    expect(ledger.forks.child.budget.read).toBe(7);
    expect(serializeLedgerShared(ledger).forks.child.budget.read).toBe(7);
  });
});
