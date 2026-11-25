// Record-level increments in the ledger snapshot.
//
// A write that moves one record must not re-copy the other records or the
// container fields, and must still notice a fork set that changed without the
// structural mark.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createBracketLedger,
  serializeLedgerShared,
  registerFork,
  markLedgerStructDirty,
  markRecordDirty,
} from "../src/scope/index.mjs";
import { registerLedger } from "../src/scope/ledger-cache.mjs";

function ledgerWith(ids) {
  const ledger = createBracketLedger();
  registerLedger(ledger);
  for (const forkId of ids) {
    assert.equal(
      registerFork(ledger, {
        forkId,
        ownerId: "root",
        fsm: "one state",
        depth: 0,
        budget: { read: 1 },
        profession: "You are a tester.",
      }).ok,
      true,
      `registerFork(${forkId}) failed`,
    );
  }
  return ledger;
}

test("moving one record reuses every other record and every container", () => {
  const ledger = ledgerWith(["a", "b", "c"]);
  const first = serializeLedgerShared(ledger);

  ledger.forks.b.task = "b, edited";
  markRecordDirty(ledger, "b");
  const second = serializeLedgerShared(ledger);

  assert.notEqual(second, first, "the snapshot must advance");
  assert.equal(second.forks.a, first.forks.a, "an untouched record keeps its copy");
  assert.equal(second.forks.c, first.forks.c, "an untouched record keeps its copy");
  assert.notEqual(second.forks.b, first.forks.b, "the moved record is re-copied");
  assert.equal(second.forks.b.task, "b, edited");

  // A clean structure means the container copies are still exact.
  assert.equal(second.order, first.order);
  assert.equal(second.queues, first.queues);
  assert.equal(second.levels, first.levels);
  assert.equal(second.rootInbox, first.rootInbox);
  assert.equal(second.totals, first.totals);
});

test("a quiet pass returns the same snapshot, not a new one", () => {
  const ledger = ledgerWith(["a"]);
  const first = serializeLedgerShared(ledger);
  markRecordDirty(ledger, "a");
  const second = serializeLedgerShared(ledger);
  const third = serializeLedgerShared(ledger);
  assert.notEqual(second, first, "the marked record was re-copied");
  assert.equal(third, second, "an unmarked pass allocates nothing");
});

test("a fork that disappears without the structural mark falls back", () => {
  const ledger = ledgerWith(["a", "b"]);
  const first = serializeLedgerShared(ledger);

  // Hostile state: the record is gone from the fork map and only a record-level
  // mark was left, never the structural one. The fast path must refuse to
  // reuse the old copy, or the snapshot would resurrect a fork that is gone.
  delete ledger.forks.b;
  markRecordDirty(ledger, "b");
  const second = serializeLedgerShared(ledger);
  assert.equal(Object.hasOwn(second.forks, "b"), false);
  assert.notEqual(second.forks, first.forks);
});

test("an invalid dirty record falls back instead of being written", () => {
  const ledger = ledgerWith(["a"]);
  const first = serializeLedgerShared(ledger);

  ledger.forks.a = { forkId: "a" }; // fails validRecord
  markRecordDirty(ledger, "a");
  const second = serializeLedgerShared(ledger);

  // The full path refuses the tree and yields the empty ledger, exactly as
  // serializeLedgerShared did before the fast path existed.
  assert.deepEqual(second.forks, {});
  assert.notEqual(second.forks, first.forks);
  assert.equal(second.order.length, 0);
});

test("a structural mark still re-copies the containers", () => {
  const ledger = ledgerWith(["a"]);
  const first = serializeLedgerShared(ledger);

  ledger.order = [...ledger.order];
  ledger.totals = { ...ledger.totals, turns: 7 };
  markLedgerStructDirty(ledger);
  const second = serializeLedgerShared(ledger);

  assert.notEqual(second.order, first.order);
  assert.notEqual(second.totals, first.totals);
  assert.equal(second.totals.turns, 7);
});
