// The serializer's incremental pass costs one walk of the live fork map.
//
// It used to cost four passes of the same size: enumerate the previous
// snapshot's keys to count them, enumerate the live keys, test membership key by
// key, and spread the old map to start a copy. The count now comes from the
// snapshot that build recorded, and the copy is built by the walk that does the
// membership test. These tests pin the resulting semantics, including the case
// a count alone cannot see: one fork removed and another added without the
// structural mark.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createBracketLedger,
  registerFork,
  serializeLedgerShared,
} from "../src/scope/index.mjs";
import {
  ledgerMeta,
  markLedgerStructDirty,
  markRecordDirty,
  registerLedger,
} from "../src/scope/ledger-cache.mjs";

function ledgerWith(ids) {
  const ledger = createBracketLedger();
  registerLedger(ledger);
  for (const forkId of ids) {
    const registered = registerFork(ledger, {
      forkId,
      ownerId: "root",
      fsm: "one state",
      depth: 0,
      budget: { read: 1 },
      profession: "You are a tester.",
    });
    assert.equal(registered.ok, true, `registerFork(${forkId}) failed`);
  }
  return ledger;
}

function record(ledger, forkId) {
  return ledger.forks[forkId];
}

test("the snapshot records how many forks it holds", () => {
  const ledger = ledgerWith(["a", "b", "c"]);
  const snapshot = serializeLedgerShared(ledger);
  assert.equal(Object.keys(snapshot.forks).length, 3);
  assert.equal(ledgerMeta(ledger).snapshotForkCount, 3);

  // A record move keeps the count; the snapshot still holds every fork.
  ledger.forks.a.task = "moved";
  markRecordDirty(ledger, "a");
  const second = serializeLedgerShared(ledger);
  assert.equal(ledgerMeta(ledger).snapshotForkCount, 3);
  assert.equal(Object.keys(second.forks).length, 3);
});

test("one moved record is copied and the rest are shared by reference", () => {
  const ledger = ledgerWith(["a", "b", "c"]);
  const first = serializeLedgerShared(ledger);

  ledger.forks.b.task = "b, edited";
  markRecordDirty(ledger, "b");
  const second = serializeLedgerShared(ledger);

  assert.notEqual(second, first);
  assert.notEqual(second.forks.b, first.forks.b, "the moved record is re-copied");
  assert.equal(second.forks.b.task, "b, edited");
  assert.equal(second.forks.a, first.forks.a, "an untouched record keeps its copy");
  assert.equal(second.forks.c, first.forks.c, "an untouched record keeps its copy");
  // The previous snapshot is not mutated by building the next one.
  assert.notEqual(first.forks.b.task, "b, edited");
});

test("a swapped fork — same count, different ids — falls back instead of guessing", () => {
  const ledger = ledgerWith(["a", "b"]);
  const first = serializeLedgerShared(ledger);
  assert.equal(ledgerMeta(ledger).snapshotForkCount, 2);

  // The count is unchanged, so a count comparison alone would accept this.
  // Only the per-id membership test can see it, and it must reject the fast
  // path: `z` has no copy in the previous snapshot.
  //
  // The records come from a second, valid history: a record whose `forkId`
  // disagrees with its key is refused by `validRecord`, and the tree under
  // test must be one that only the fast path's membership test can reject.
  const other = serializeLedgerShared(ledgerWith(["b", "z"]));
  ledger.forks = { ...other.forks };
  ledger.order = ["b", "z"];
  // A record-level mark, never the structural one.
  markRecordDirty(ledger, "b");

  const second = serializeLedgerShared(ledger);
  assert.deepEqual(Object.keys(second.forks).sort(), ["b", "z"]);
  assert.equal(Object.hasOwn(second.forks, "a"), false, "a removed fork is not resurrected");
  // The fallback rebuilt the tree, so it reports the size it actually built.
  assert.equal(ledgerMeta(ledger).snapshotForkCount, 2);
});

test("a fork that vanished is not resurrected even when a dirty mark names it", () => {
  const ledger = ledgerWith(["a", "b"]);
  serializeLedgerShared(ledger);

  delete ledger.forks.b;
  ledger.order = ["a"];
  markRecordDirty(ledger, "b"); // the record it names no longer exists

  const next = serializeLedgerShared(ledger);
  assert.deepEqual(Object.keys(next.forks), ["a"]);
  assert.equal(ledgerMeta(ledger).snapshotForkCount, 1);
});

test("a structural rebuild records the count it built", () => {
  const ledger = ledgerWith(["a", "b", "c"]);
  serializeLedgerShared(ledger);

  delete ledger.forks.c;
  ledger.order = ledger.order.filter((forkId) => forkId !== "c");
  markLedgerStructDirty(ledger);
  const next = serializeLedgerShared(ledger);

  assert.deepEqual(Object.keys(next.forks).sort(), ["a", "b"]);
  assert.equal(ledgerMeta(ledger).snapshotForkCount, 2);

  // And the incremental path that follows trusts the new count.
  ledger.forks.a.task = "after rebuild";
  markRecordDirty(ledger, "a");
  const third = serializeLedgerShared(ledger);
  assert.equal(third.forks.b, next.forks.b, "the rebuild's copy is reused");
  assert.equal(third.forks.a.task, "after rebuild");
  assert.equal(ledgerMeta(ledger).snapshotForkCount, 2);
});

test("an untracked ledger still serializes by value", () => {
  // No registration means no metadata: the whole-tree path must still work.
  // The record is taken from a registered ledger's snapshot so it has the
  // shape `validRecord` accepts, rather than a hand-written approximation.
  const source = serializeLedgerShared(ledgerWith(["a"]));
  const ledger = createBracketLedger();
  ledger.forks.a = source.forks.a;
  ledger.order = ["a"];
  const snapshot = serializeLedgerShared(ledger);
  assert.deepEqual(Object.keys(snapshot.forks), ["a"]);
  assert.notEqual(snapshot, source, "an untracked ledger always copies");
});

test("a same-count swap that appeared without the structural mark falls back", () => {
  // One fork leaves and another arrives: the record count is unchanged, so the
  // count check alone cannot see that the id set moved. The incoming record is
  // dirty, which is what hides the swap from the dirty-led membership test too.
  // The fast path reuses the previous `order`, so accepting this would store a
  // tree whose `order` names a fork that is gone and omits one that exists;
  // `validLedger` rejects that tree on load and the history is discarded.
  const ledger = ledgerWith(["a", "b"]);
  const first = serializeLedgerShared(ledger);
  assert.deepEqual(first.order, ["a", "b"]);

  // A valid record from another history, so `validRecord` accepts it and only
  // the container mismatch under test remains.
  const incoming = serializeLedgerShared(ledgerWith(["z"]));
  delete ledger.forks.a;
  ledger.forks.z = incoming.forks.z;
  ledger.order = ["z", "b"];
  markRecordDirty(ledger, "z");

  const second = serializeLedgerShared(ledger);

  assert.deepEqual(Object.keys(second.forks).sort(), ["b", "z"]);
  // The containers must describe the tree that was actually written.
  assert.deepEqual(second.order, ["z", "b"]);
  assert.notEqual(second.order, first.order, "a stale order must not be reused");
  assert.equal(second.forks.b, first.forks.b, "the untouched record still shares");
  assert.equal(ledgerMeta(ledger).snapshotForkCount, 2);
});
