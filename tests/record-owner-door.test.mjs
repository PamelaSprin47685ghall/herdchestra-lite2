// Every record reachable through `forkOf` belongs to a ledger, so the
// record-only mutation door can find that ledger.
//
// `touchRecord(record)` takes a record and no ledger: it resolves the owner
// through a weak map that `registerRecord` fills. That is the only way the
// clock, the panhandle and the send paths can mark a change when they hold a
// record rather than the tree. If any path can hand out a record that was never
// registered, a mutation through that door marks nothing and the change is
// silently dropped — the tree stays consistent, the journal never learns.
//
// These cases pin the invariant rather than any particular caller: a record is
// either born through `registerFork` or reconstructed by a fold, and both must
// leave it registered. They do not run the production write paths; they assert
// that the door those paths use is wired.

import { describe, expect, test } from "bun:test";

import {
  createState,
  serializeState,
  deserializeState,
  registerFork,
  createBracketLedger,
} from "../src/scope/index.mjs";
import { forkOf, markReady } from "../src/scope/forkjoin.mjs";
import {
  commitConsumer,
  consumerPending,
  ledgerPending,
  registerConsumer,
  touchRecord,
} from "../src/scope/ledger-cache.mjs";

function stateWithFork(forkId = "f-1") {
  const state = createState();
  state.brackets = createBracketLedger();
  const registered = registerFork(state.brackets, {
    forkId,
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a tester.",
  });
  expect(registered.ok).toBe(true);
  return { state, registered };
}

describe("a record born through registerFork", () => {
  test("its owner is already known, so touchRecord reaches the ledger", () => {
    const { state, registered } = stateWithFork();
    const record = registered.fork;

    // Registration marked the id, so clear the row to see the next mark on its
    // own. `commitConsumer` is the only place a row is cleared.
    ledgerPending(state.brackets);
    commitConsumer(state.brackets);

    record.task = "edited through the record door";
    touchRecord(record);

    const pending = ledgerPending(state.brackets);
    expect(pending).not.toBeNull();
    expect(pending.records).toContain("f-1");
  });

  test("forkOf hands back the same registered object", () => {
    const { state, registered } = stateWithFork();
    expect(forkOf(state.brackets, "f-1")).toBe(registered.fork);
  });

  test("a domain function that writes through forkOf still marks", () => {
    const { state } = stateWithFork();
    ledgerPending(state.brackets);
    commitConsumer(state.brackets);

    // `markReady` takes the record from `forkOf` and writes it in place; it is
    // the shape every domain mutator has. The ledger must owe it afterwards
    // without the caller passing the id again.
    const outcome = markReady(state.brackets, "f-1", { ok: true, record: "done" });
    expect(outcome.ok ?? true).toBe(true);

    const pending = ledgerPending(state.brackets);
    // `pending === null` would mean nothing is owed at all — the silent drop
    // this door exists to prevent. Accepting it (as the previous form did)
    // made the assertion unable to fail for the reason it was written.
    expect(pending).not.toBeNull();
    expect(pending.records).toContain("f-1");
    // A structural change is expected here too (receiveSeq, queues).
    expect(pending.struct).toBe(true);
  });
});

describe("a record reconstructed by state deserialization", () => {
  test("is registered, so a later touchRecord is not silently dropped", () => {
    const { state } = stateWithFork();
    // The fold produces a serialized value; ownership registration occurs at
    // deserializeState/restoreLedgerChecked, not during the pure fold itself.
    const folded = deserializeState(serializeState(state));
    expect(folded).not.toBeNull();
    const record = forkOf(folded.brackets, "f-1");
    expect(record).not.toBeNull();

    // The restored tree is a different object graph from the journal entries.
    // If the fold skipped registration, this mark would go nowhere.
    ledgerPending(folded.brackets);
    commitConsumer(folded.brackets);

    record.task = "edited after restore";
    touchRecord(record);

    const pending = ledgerPending(folded.brackets);
    expect(pending).not.toBeNull();
    expect(pending.records).toContain("f-1");
  });
});

describe("a record from a foreign ledger", () => {
  test("marks its own ledger and never another", () => {
    const one = stateWithFork("a");
    const two = stateWithFork("b");
    const record = forkOf(one.state.brackets, "a");

    for (const ledger of [one.state.brackets, two.state.brackets]) {
      ledgerPending(ledger);
      commitConsumer(ledger);
    }

    touchRecord(record);

    expect(ledgerPending(one.state.brackets).records).toContain("a");
    expect(ledgerPending(two.state.brackets).records).not.toContain("a");
  });

  test("an unregistered object is ignored rather than throwing", () => {
    expect(() => touchRecord({ forkId: "unknown" })).not.toThrow();
    expect(() => touchRecord(null)).not.toThrow();
    expect(() => touchRecord(undefined)).not.toThrow();
  });
});

describe("per-writer rows see the same record", () => {
  test("a named writer owes an id marked before it registered", () => {
    const { state } = stateWithFork();
    // A writer that registers afterwards must not inherit the impression that
    // the tree is already stored: `consumerRow` starts with `struct: true`, and
    // the record it has never written is still owed. This is the case that a
    // ledger-wide pending set got wrong.
    const row = registerConsumer(state.brackets, "station-b");
    expect(row.struct).toBe(true);

    commitConsumer(state.brackets, "station-b");
    const record = forkOf(state.brackets, "f-1");
    record.task = "after station-b registered";
    touchRecord(record);

    const pending = consumerPending(state.brackets, "station-b");
    expect(pending).not.toBeNull();
    expect(pending.records).toContain("f-1");
  });
});
