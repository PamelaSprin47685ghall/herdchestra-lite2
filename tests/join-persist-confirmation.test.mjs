// Join persistence: a receipt that exists only in memory must say so.
//
// `station.persist()` is the durable-write signal. When it reports false the
// join still succeeds (the receipt is in the in-memory chain), but the result
// carries `details.persisted === false` and a warning the model can read.
// A station double without `persist` is not judged and keeps the old shape.

import { describe, expect, test } from "bun:test";

import {
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
  takeReady,
} from "../src/scope/forkjoin.mjs";
import { handleJoinCall } from "../src/station/fork-controls.mjs";
import { SessionStation } from "../src/station/station.mjs";

function ledgerWithReady(id, record = "child says done") {
  const ledger = createBracketLedger();
  registerFork(ledger, {
    forkId: id,
    ownerId: "root",
    levelKey: "root|0|0",
    knuth_nfa_inspired_fsm: `work ${id}`,
    depth: 0,
  });
  markReady(ledger, id, { ok: true, record });
  return ledger;
}

function stationFor(ledger, options = {}) {
  const state = { relay: { generation: 0, fullFlow: false } };
  return {
    state,
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => null,
    forkOwnerId: () => null,
    contextMessages: () => [],
    currentContextTokens: () => 0,
    tokensPerCharFor: () => 1,
    childOutcomePort: () => null,
    usage: { lastUsageModelKey: null },
    ...options,
  };
}

function joinCall(id = "j1") {
  return { id, arguments: {} };
}

describe("an immediate join and its durable receipt", () => {
  test("a failed write keeps joined true and names the unpersisted receipt", () => {
    const ledger = ledgerWithReady("f1");
    const station = stationFor(ledger, { persist: () => false });
    const out = handleJoinCall(station, joinCall());

    expect(out.isError).toBeUndefined();
    expect(out.details.joined).toBe(true);
    expect(out.details.persisted).toBe(false);
    expect(out.content[0].text).toContain("Persistence warning");
  });

  test("a successful write carries persisted true and no warning", () => {
    const ledger = ledgerWithReady("f2");
    const station = stationFor(ledger, { persist: () => true });
    const out = handleJoinCall(station, joinCall("j2"));

    expect(out.details.persisted).toBe(true);
    expect(out.content[0].text).not.toContain("Persistence warning");
  });

  test("a station without persist is not judged", () => {
    const ledger = ledgerWithReady("f3");
    const station = stationFor(ledger);
    const out = handleJoinCall(station, joinCall("j3"));

    expect(out.details.joined).toBe(true);
    expect("persisted" in out.details).toBe(false);
    expect(out.content[0].text).not.toContain("Persistence warning");
  });
});

describe("a wait-finalized join and its durable receipt", () => {
  function finalizeOn(ledger, persist) {
    const station = stationFor(ledger, {
      persist,
      processed: { setHandled() {}, markCall() {} },
    });
    const taken = takeReady(ledger, { ownerId: "root", levelKey: "root|0|0" });
    expect(taken.ok).toBe(true);
    return SessionStation.prototype.finalizeJoin.call(
      station,
      "wait-1",
      taken.fork,
      {},
    );
  }

  test("a failed write is reported on the finalized result", () => {
    const ledger = ledgerWithReady("g1");
    let writes = 0;
    const out = finalizeOn(ledger, () => {
      writes += 1;
      return false;
    });

    expect(out.details.persisted).toBe(false);
    expect(out.content[0].text).toContain("Persistence warning");
    // `confirmJoinPersistence` and the final control-state write each report.
    expect(writes).toBe(2);
  });

  test("a successful write stays silent", () => {
    const ledger = ledgerWithReady("g2");
    const out = finalizeOn(ledger, () => true);

    expect(out.details.persisted).toBe(true);
    expect(out.content[0].text).not.toContain("Persistence warning");
  });
});

describe("the bracket closes even when the write fails", () => {
  test("the in-memory ledger still holds the closed bracket", () => {
    const ledger = ledgerWithReady("h1");
    const station = stationFor(ledger, { persist: () => false });
    handleJoinCall(station, joinCall("j4"));

    const record = forkOf(ledger, "h1");
    expect(record.status).toBe("joined");
  });
});
