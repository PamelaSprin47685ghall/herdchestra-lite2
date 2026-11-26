// The ledger journal: fork history is written once per change, never carried
// inside a scope checkpoint, and a chain of both entries restores exactly what
// the old whole-state chain restored.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createState,
  serializeState,
  serializeStateShared,
  deserializeState,
  planStateEntry,
  planLedgerEntry,
  splitState,
  foldStateChain,
  isLedgerEntry,
  isStateCheckpoint,
  createBracketLedger,
  registerFork,
  markLedgerStructDirty,
  markRecordDirty,
} from "../src/scope/index.mjs";

function stateWithLedger() {
  const state = createState();
  state.brackets = createBracketLedger();
  return state;
}

// A record built by the production path, so `validLedger` accepts it: the
// journal must round-trip what the runtime actually writes, not a mock shape.
function addFork(state, forkId) {
  const spec = {
    forkId,
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  };
  const registered = registerFork(state.brackets, spec);
  assert.equal(registered.ok, true, `registerFork(${forkId}) failed`);
  return registered.fork;
}

test("a checkpoint carries no fork ledger", () => {
  const state = stateWithLedger();
  state.seq = 3;
  addFork(state, "a");
  const full = serializeStateShared(state);
  const { core, brackets } = splitState(full);
  assert.equal(Object.hasOwn(core, "brackets"), false);
  assert.equal(typeof brackets, "object");
  assert.equal(core.seq, 3);
});

test("a ledger entry names only the records that moved", () => {
  const state = stateWithLedger();
  addFork(state, "a");
  addFork(state, "b");

  const first = planLedgerEntry(state, null);
  assert.ok(first.entry, "the first write establishes the ledger");
  assert.equal(isLedgerEntry(first.entry), true);
  assert.deepEqual(Object.keys({ ...first.entry.set, ...(first.entry.patches ?? {}) }).sort(), ["a", "b"]);
  assert.ok(first.entry.head, "the first entry establishes the containers");

  // Touch one record. The next entry carries that record and nothing else.
  state.brackets.forks.a.task = "first, edited";
  markRecordDirty(state.brackets, "a");
  const second = planLedgerEntry(state, first.brackets);
  assert.ok(second.entry);
  assert.deepEqual(Object.keys({ ...second.entry.set, ...(second.entry.patches ?? {}) }), ["a"]);
  assert.equal(second.entry.head, null, "untouched containers cost no bytes");

  // Nothing moved: no entry at all.
  const third = planLedgerEntry(state, second.brackets);
  assert.equal(third.entry, null);
});

test("a removed fork is deleted by id, not by rebuilding the tree", () => {
  const state = stateWithLedger();
  addFork(state, "a");
  addFork(state, "b");
  const first = planLedgerEntry(state, null);

  delete state.brackets.forks.b;
  state.brackets.order = state.brackets.order.filter((id) => id !== "b");
  markLedgerStructDirty(state.brackets);

  const second = planLedgerEntry(state, first.brackets);
  assert.deepEqual(second.entry.del, ["b"]);
  assert.equal(Object.hasOwn(second.entry.set, "b"), false);
});

test("a chain of checkpoints, deltas and ledger entries folds back", () => {
  const state = stateWithLedger();
  addFork(state, "w");

  const entries = [];
  let prevCore = null;
  let prevBrackets = null;
  let writes = 0;
  const commit = (seq) => {
    state.seq = seq;
    const ledgerPlan = planLedgerEntry(state, prevBrackets);
    const { core } = splitState(serializeStateShared(state));
    const entry = planStateEntry(prevCore, core, writes);
    if (ledgerPlan.entry) {
      entries.push(ledgerPlan.entry);
      prevBrackets = ledgerPlan.brackets;
    }
    if (entry) {
      entries.push(entry);
      prevCore = core;
      writes = entry.kind === "checkpoint" ? 0 : writes + 1;
    }
  };

  commit(1);
  // Many writes: a checkpoint must keep appearing without the ledger inside.
  for (let seq = 2; seq <= 71; seq += 1) commit(seq);
  state.brackets.forks.w.record = "worker, returned";
  markRecordDirty(state.brackets, "w");
  commit(1000);

  const checkpoints = entries.filter(
    (entry) => !isLedgerEntry(entry) && isStateCheckpoint(entry),
  );
  assert.ok(checkpoints.length >= 2, "periodic checkpoints still exist");
  for (const checkpoint of checkpoints) {
    assert.equal(
      Object.hasOwn(checkpoint.state, "brackets"),
      false,
      "a checkpoint must not carry the fork ledger",
    );
  }
  assert.ok(
    entries.some((entry) => isLedgerEntry(entry)),
    "the fork history is written as ledger entries",
  );

  const folded = foldStateChain(entries);
  assert.ok(folded);
  assert.equal(folded.seq, 1000);
  assert.deepEqual(Object.keys(folded.brackets.forks), ["w"]);
  assert.equal(folded.brackets.forks.w.record, "worker, returned");
  // The per-call charge trail is retired; the fold carries state and brackets.

  const restored = deserializeState(folded);
  assert.equal(restored.seq, 1000);
  assert.equal(restored.brackets.forks.w.record, "worker, returned");
});

test("a version-2 chain still restores unchanged", () => {
  // The old shape: one envelope carrying the whole state, ledger included.
  const state = stateWithLedger();
  state.seq = 7;
  addFork(state, "legacy");
  const legacyEntry = {
    version: 2,
    kind: "checkpoint",
    state: serializeState(state),
  };
  const folded = foldStateChain([legacyEntry]);
  const restored = deserializeState(folded);
  assert.equal(restored.seq, 7);
  assert.equal(restored.brackets.forks.legacy.forkId, "legacy");
});

test("a ledger entry never anchors a state replay", () => {
  const state = stateWithLedger();
  const { core } = splitState(serializeStateShared(state));
  const checkpoint = planStateEntry(null, core, 0);
  const ledgerEntry = { version: 3, kind: "ledger", set: {}, del: [], head: null };
  assert.equal(isStateCheckpoint(checkpoint), true);
  assert.equal(isStateCheckpoint(ledgerEntry), false);
  assert.equal(isLedgerEntry(checkpoint), false);
});

test("the ledger's container fields ride along only when they change", () => {
  const state = stateWithLedger();
  addFork(state, "x");
  const first = planLedgerEntry(state, null);
  assert.ok(first.entry.head, "a first write establishes the containers");
  // A baseline names the lists whole; later writes name only their edits.
  assert.equal(first.entry.order.length, 1);
  const second = planLedgerEntry(state, first.brackets);
  assert.equal(second.entry, null, "a quiet write stores nothing");
});

test("an invalid live ledger is never written as a deletion", () => {
  // A corrupt in-memory tree would serialize to an empty one. Writing that
  // would erase the stored fork history, so the write is refused instead.
  const state = stateWithLedger();
  addFork(state, "kept");
  const first = planLedgerEntry(state, null);
  assert.ok(first.entry);

  state.brackets.forks.ghost = { forkId: "ghost" }; // not in order
  const second = planLedgerEntry(state, first.brackets);
  assert.equal(second.entry, null);
  assert.equal(second.brackets, first.brackets);
});
