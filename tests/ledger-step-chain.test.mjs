// The serializer's step chain: what moved, carried forward without comparing
// the fork map.
//
// `planLedgerEntry` used to answer "which records changed" by comparing every
// fork id against the previous snapshot. The serializer already knows, because
// it is the one copying the records; these tests pin that knowledge down, and
// pin the fallbacks that keep the answer exact when it is not available.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createBracketLedger,
  planLedgerEntry,
  registerFork,
  serializeLedgerShared,
} from "../src/scope/index.mjs";
import {
  markLedgerStructDirty,
  markRecordDirty,
  netChangeSince,
  noteSnapshotStep,
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

function keysOf(setLike) {
  return Object.keys(setLike ?? {}).sort();
}

test("the step chain accumulates every record that moved along it", () => {
  const ledger = ledgerWith(["a", "b", "c"]);
  const s0 = serializeLedgerShared(ledger); // structural rebuild: step unknown

  ledger.forks.a.task = "x";
  markRecordDirty(ledger, "a");
  const s1 = serializeLedgerShared(ledger);

  ledger.forks.b.task = "y";
  markRecordDirty(ledger, "b");
  const s2 = serializeLedgerShared(ledger);

  // One hop: exactly the record that moved.
  assert.deepEqual([...netChangeSince(ledger, s0, s1).set], ["a"]);
  // Two hops: the union, replayed in order. `c` never moved.
  assert.deepEqual([...netChangeSince(ledger, s0, s2).set].sort(), ["a", "b"]);
  // Nothing moved between these two.
  assert.equal(netChangeSince(ledger, s2, s2), null);
});

test("a structural rebuild retains its exact changed record set", () => {
  const ledger = ledgerWith(["a", "b"]);
  const s0 = serializeLedgerShared(ledger);

  ledger.forks.a.task = "x";
  markRecordDirty(ledger, "a");
  const s1 = serializeLedgerShared(ledger);

  // Rebuilding containers does not alter any record; retain this exact empty
  // step rather than forcing another traversal of the complete fork map.
  markLedgerStructDirty(ledger);
  const s2 = serializeLedgerShared(ledger);

  assert.deepEqual([...netChangeSince(ledger, s1, s2).set], []);
  assert.deepEqual([...netChangeSince(ledger, s0, s2).set], ["a"]);
});

test("a snapshot off the chain falls back rather than answering", () => {
  const one = ledgerWith(["a"]);
  const other = ledgerWith(["b"]);
  const s0 = serializeLedgerShared(one);
  const s1 = serializeLedgerShared(other);

  // Two separate histories: no step relates them.
  assert.equal(netChangeSince(one, s0, s1), null);
});

test("an entry names only the record that moved, not the whole map", () => {
  const ledger = ledgerWith(["a", "b", "c"]);
  const state = { brackets: ledger };

  const first = planLedgerEntry(state, null);
  assert.ok(first.entry.full, "the first write is a replacement baseline");
  assert.deepEqual(keysOf({ ...first.entry.set, ...(first.entry.patches ?? {}) }), ["a", "b", "c"]);

  ledger.forks.c.task = "moved";
  markRecordDirty(ledger, "c");
  const second = planLedgerEntry(state, first.brackets);

  assert.deepEqual(keysOf({ ...second.entry.set, ...(second.entry.patches ?? {}) }), ["c"]);
  assert.deepEqual(second.entry.del, []);
  assert.equal(second.entry.full, undefined, "a steady write is not a baseline");
  assert.equal(second.entry.head, null, "no container moved");

  // A quiet pass writes nothing at all.
  const third = planLedgerEntry(state, second.brackets);
  assert.equal(third.entry, null);
});

test("a retry against the same durable snapshot still names the same record", () => {
  const ledger = ledgerWith(["a", "b"]);
  const state = { brackets: ledger };
  const base = planLedgerEntry(state, null).brackets;

  ledger.forks.a.task = "first attempt fails";
  markRecordDirty(ledger, "a");
  const attempt = planLedgerEntry(state, base);
  assert.deepEqual(keysOf({ ...attempt.entry.set, ...(attempt.entry.patches ?? {}) }), ["a"]);

  // The append failed, so the durable snapshot never advanced. The retry runs
  // the serializer again (which already cleared its own dirty mark) and must
  // still answer from the same baseline, not from "nothing moved".
  const retry = planLedgerEntry(state, base);
  assert.ok(retry.entry, "a retry must still owe the write");
  assert.deepEqual(keysOf({ ...retry.entry.set, ...(retry.entry.patches ?? {}) }), ["a"]);
});

test("a record deleted by an older step and re-created by a newer one is a set", () => {
  // The chain is walked newest first, so the newer decision must stand. A fork
  // that an older step deleted and a newer step re-created is live right now:
  // reporting it as `del` would drop a record that exists.
  const ledger = ledgerWith(["a"]);
  const s0 = serializeLedgerShared(ledger);
  const s1 = { tag: "after-delete" };
  const s2 = { tag: "after-recreate" };
  noteSnapshotStep(ledger, s1, s0, { set: [], del: ["a"] });
  noteSnapshotStep(ledger, s2, s1, { set: ["a"], del: [] });

  const net = netChangeSince(ledger, s0, s2);
  assert.deepEqual([...net.set], ["a"]);
  assert.deepEqual([...net.del], []);
});

test("a record created by an older step and deleted by a newer one is a deletion", () => {
  const ledger = ledgerWith(["a"]);
  const s0 = serializeLedgerShared(ledger);
  const s1 = { tag: "after-create" };
  const s2 = { tag: "after-delete" };
  noteSnapshotStep(ledger, s1, s0, { set: ["b"], del: [] });
  noteSnapshotStep(ledger, s2, s1, { set: [], del: ["b"] });

  const net = netChangeSince(ledger, s0, s2);
  assert.deepEqual([...net.del], ["b"]);
  assert.deepEqual([...net.set], []);
});

test("the retained chain is bounded, and a deeper question falls back", () => {
  // Every snapshot keeps its own fork map, so an unbounded chain would retain
  // one map per write for the life of the process.
  const ledger = ledgerWith(["a"]);
  const snapshots = [serializeLedgerShared(ledger)];
  for (let writes = 0; writes < 40; writes += 1) {
    ledger.forks.a.task = `task ${writes}`;
    markRecordDirty(ledger, "a");
    snapshots.push(serializeLedgerShared(ledger));
  }

  const newest = snapshots.at(-1);
  // The step a durable write legitimately lags behind is still answered.
  assert.deepEqual([...netChangeSince(ledger, snapshots.at(-2), newest).set], ["a"]);
  // Anything older than the bound answers null, which sends the caller to the
  // exact comparison instead of a wrong delta.
  assert.equal(netChangeSince(ledger, snapshots[0], newest), null);
  assert.equal(netChangeSince(ledger, snapshots.at(-20), newest), null);
});

test("registration and removal produce exact steps for older baselines", () => {
  const ledger = ledgerWith(["a", "b"]);
  const s0 = serializeLedgerShared(ledger);
  const added = registerFork(ledger, {
    forkId: "c", ownerId: "root", fsm: "work", depth: 0, budget: {},
  });
  assert.equal(added.ok, true);
  const s1 = serializeLedgerShared(ledger);
  delete ledger.forks.b;
  ledger.order = ledger.order.filter((id) => id !== "b");
  markLedgerStructDirty(ledger);
  const s2 = serializeLedgerShared(ledger);

  const change = netChangeSince(ledger, s0, s2);
  assert.deepEqual([...change.set], ["c"]);
  assert.deepEqual([...change.del], ["b"]);
  assert.deepEqual([...netChangeSince(ledger, s1, s2).del], ["b"]);
});

test("a removal after a rebuild is still deleted by id", () => {
  const ledger = ledgerWith(["a", "b"]);
  const state = { brackets: ledger };
  const first = planLedgerEntry(state, null);

  delete ledger.forks.b;
  ledger.order = ledger.order.filter((forkId) => forkId !== "b");
  markLedgerStructDirty(ledger);
  const second = planLedgerEntry(state, first.brackets);

  // The structural rebuild has no per-record step, so this answer comes from
  // the exact comparison — the fallback that keeps removal correct.
  assert.deepEqual(second.entry.del, ["b"]);
  assert.deepEqual(keysOf({ ...second.entry.set, ...(second.entry.patches ?? {}) }), []);
  assert.ok(second.entry.head, "the stored order must change with the removal");
});
