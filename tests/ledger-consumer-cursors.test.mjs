// What each journal still owes, asked per writer.
//
// A single ledger-wide "unpersisted" set was wrong whenever two writers shared
// one ledger while ending their journals at different baselines: the writer that
// appended first cleared the shared mark, and the writer that had not yet
// stored the change then computed its increment from a baseline it believed was
// current. The change it owed disappeared from that journal with no error,
// because the tree it wrote was internally consistent.
//
// These cases drive the row-per-writer API directly, plus the legacy
// single-writer names, which must keep their old behaviour byte for byte.

import { describe, test, expect } from "bun:test";

import {
  createState,
  createBracketLedger,
  registerFork,
  markRecordDirty,
  markLedgerStructDirty,
} from "../src/scope/index.mjs";
import {
  commitConsumer,
  commitPersisted,
  consumerPending,
  dropConsumer,
  ledgerMeta,
  ledgerPending,
  registerConsumer,
  registerLedger,
} from "../src/scope/ledger-cache.mjs";

function freshLedger() {
  const state = createState();
  state.brackets = createBracketLedger();
  registerLedger(state.brackets);
  return state.brackets;
}

function addFork(ledger, forkId) {
  const registered = registerFork(ledger, {
    forkId,
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);
  return registered.fork;
}

describe("the legacy single-writer names", () => {
  test("behave exactly as before: a baseline first, then only what moved", () => {
    const ledger = freshLedger();
    addFork(ledger, "a");
    // Registration owes both the structure and the newly created record.
    const first = ledgerPending(ledger);
    expect(first.struct).toBe(true);
    expect(first.records).toEqual(["a"]);

    commitPersisted(ledger);
    expect(ledgerPending(ledger).struct).toBe(false);
    expect(ledgerPending(ledger).records).toEqual([]);

    ledger.forks.a.task = "edited";
    markRecordDirty(ledger, "a");
    expect(ledgerPending(ledger).records).toEqual(["a"]);

    // A failed append never reaches commitPersisted, so the debt survives and
    // the retry owes exactly what the failed attempt owed.
    expect(ledgerPending(ledger).records).toEqual(["a"]);

    commitPersisted(ledger);
    expect(ledgerPending(ledger).records).toEqual([]);
    expect(ledgerPending(ledger).struct).toBe(false);
  });

  test("a mark taken before the first read is not lost", () => {
    const ledger = freshLedger();
    addFork(ledger, "a");
    // No ledgerPending call yet: the row must already exist, or this mark would
    // land in nothing and the write would answer "nothing owed".
    ledger.forks.a.task = "edited early";
    markRecordDirty(ledger, "a");
    expect(ledgerPending(ledger).records).toEqual(["a"]);
  });
});

describe("two writers over one ledger", () => {
  test("one writer's accepted append does not clear the other's debt", () => {
    const ledger = freshLedger();
    registerConsumer(ledger, "journal-a");
    registerConsumer(ledger, "journal-b");
    addFork(ledger, "a");
    addFork(ledger, "b");

    // Both owe a baseline: neither has written anything yet.
    expect(consumerPending(ledger, "journal-a").struct).toBe(true);
    expect(consumerPending(ledger, "journal-b").struct).toBe(true);
    commitConsumer(ledger, "journal-a");
    commitConsumer(ledger, "journal-b");

    // A record moves. Both journals owe it.
    ledger.forks.a.task = "first edit";
    markRecordDirty(ledger, "a");
    expect(consumerPending(ledger, "journal-a").records).toEqual(["a"]);
    expect(consumerPending(ledger, "journal-b").records).toEqual(["a"]);

    // Journal A stores it. Journal B has not, and must still owe it — this is
    // the case the shared mark got wrong.
    commitConsumer(ledger, "journal-a");
    expect(consumerPending(ledger, "journal-a").records).toEqual([]);
    expect(consumerPending(ledger, "journal-b").records).toEqual(["a"]);

    // A second change arrives before B catches up: B owes both.
    ledger.forks.b.task = "second edit";
    markRecordDirty(ledger, "b");
    expect(consumerPending(ledger, "journal-b").records.sort()).toEqual(["a", "b"]);
    expect(consumerPending(ledger, "journal-a").records).toEqual(["b"]);

    commitConsumer(ledger, "journal-b");
    expect(consumerPending(ledger, "journal-b").records).toEqual([]);
  });

  test("a structural mark reaches every writer", () => {
    const ledger = freshLedger();
    registerConsumer(ledger, "journal-a");
    registerConsumer(ledger, "journal-b");
    commitConsumer(ledger, "journal-a");
    commitConsumer(ledger, "journal-b");

    ledger.order = [...ledger.order];
    markLedgerStructDirty(ledger);

    expect(consumerPending(ledger, "journal-a").struct).toBe(true);
    expect(consumerPending(ledger, "journal-b").struct).toBe(true);

    commitConsumer(ledger, "journal-a");
    expect(consumerPending(ledger, "journal-a").struct).toBe(false);
    expect(consumerPending(ledger, "journal-b").struct).toBe(true);
  });

  test("the legacy writer is just another row", () => {
    const ledger = freshLedger();
    registerConsumer(ledger, "journal-a");
    addFork(ledger, "a");
    commitPersisted(ledger);
    commitConsumer(ledger, "journal-a");

    ledger.forks.a.task = "edited";
    markRecordDirty(ledger, "a");

    // Both see it; committing one leaves the other owing.
    expect(ledgerPending(ledger).records).toEqual(["a"]);
    expect(consumerPending(ledger, "journal-a").records).toEqual(["a"]);
    commitPersisted(ledger);
    expect(ledgerPending(ledger).records).toEqual([]);
    expect(consumerPending(ledger, "journal-a").records).toEqual(["a"]);
  });

  test("an unknown writer owes a baseline rather than a delta", () => {
    const ledger = freshLedger();
    addFork(ledger, "a");
    commitPersisted(ledger);
    ledger.forks.a.task = "edited";
    markRecordDirty(ledger, "a");

    // A writer registered after the fact has no baseline to subtract from, so
    // it must be told to write the whole tree — not handed someone else's marks.
    registerConsumer(ledger, "late");
    const row = consumerPending(ledger, "late");
    expect(row.struct).toBe(true);
    expect(row.records).toEqual([]);
  });
});

describe("bounded memory", () => {
  test("a writer that never flushes stops counting and is told to compare", () => {
    const ledger = freshLedger();
    registerConsumer(ledger, "journal-a");
    commitConsumer(ledger, "journal-a");

    // More distinct records than one row may hold. The row must not grow with
    // the session: it forgets the ids and answers null, which means "compare
    // exactly". Answering a truncated id list instead would drop changes.
    const total = 5000;
    for (let index = 0; index < total; index += 1) {
      ledger.forks[`f${index}`] = { forkId: `f${index}`, task: "t" };
      markRecordDirty(ledger, `f${index}`);
    }
    expect(consumerPending(ledger, "journal-a")).toBeNull();

    // A different writer that committed recently is unaffected: its own row is
    // empty and still exact.
    registerConsumer(ledger, "journal-b");
    commitConsumer(ledger, "journal-b");
    ledger.forks.extra = { forkId: "extra", task: "t" };
    markRecordDirty(ledger, "extra");
    expect(consumerPending(ledger, "journal-b").records).toEqual(["extra"]);

    // After that writer writes, its row is clean and counts again.
    commitConsumer(ledger, "journal-a");
    expect(consumerPending(ledger, "journal-a").records).toEqual([]);
    expect(consumerPending(ledger, "journal-a").struct).toBe(false);
  });

  test("rows do not outlive the writer that asked for them", () => {
    const ledger = freshLedger();
    registerConsumer(ledger, "journal-a");
    registerConsumer(ledger, "journal-b");
    expect(ledgerMeta(ledger).consumers.size).toBe(2);

    dropConsumer(ledger, "journal-a");
    expect(ledgerMeta(ledger).consumers.size).toBe(1);
    // A dropped writer that comes back owes a baseline again.
    registerConsumer(ledger, "journal-a");
    expect(consumerPending(ledger, "journal-a").struct).toBe(true);
  });
});
