// The batch registers completely before the first child starts.
//
// A spawner runs host code synchronously. If registration and spawning share
// one loop, a throw from the first spawner (or a child that reads the ledger
// on its first beat) can observe a batch whose later forks do not exist yet.
// This test drives two forks where the first spawner throws: the second fork
// must still be registered and started.

import { describe, expect, test } from "bun:test";

import {
  FAILED,
  READY,
  RUNNING,
  createBracketLedger,
  forkOf,
} from "../src/scope/forkjoin.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";

function stationFor(ledger, options = {}) {
  return {
    state: { receipts: [], relay: { generation: 0, fullFlow: false } },
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

function forkArgs(overrides = {}) {
  return {
    scopeId: "one",
    intent: "audit the first seam",
    budget: {},
    time: 60,
    targets: ["src/parser.mjs"],
    ...overrides,
  };
}

describe("a batch whose first spawner throws", () => {
  test("registers every fork before spawning and still starts the second", () => {
    const ledger = createBracketLedger();
    const seenAtSpawn = [];
    const spawned = [];
    const station = stationFor(ledger, {
      childSpawnPort: () => (spec) => {
        seenAtSpawn.push({
          forkId: spec.forkId,
          order: ledger.order.slice(),
          statuses: ledger.order.map((id) => forkOf(ledger, id).status),
        });
        if (spec.forkId === "batch:0") throw new Error("spawn refused");
        spawned.push(spec);
      },
    });

    const out = handleForkCall(station, {
      id: "batch",
      arguments: { forks: [forkArgs(), forkArgs({ scopeId: "two", intent: "audit the second seam" })] },
    });

    expect(out.isError).toBeUndefined();
    expect(out.details.started).toEqual(["batch:1"]);
    expect(out.details.failed).toEqual(["batch:0"]);
    expect(out.details.deferred).toEqual([]);

    // The decisive proof: at the first spawn call, both forks already exist
    // and are running, so the failing start cannot strand the second one.
    expect(seenAtSpawn[0]).toEqual({
      forkId: "batch:0",
      order: ["batch:0", "batch:1"],
      statuses: [RUNNING, RUNNING],
    });
    expect(seenAtSpawn[1].forkId).toBe("batch:1");
    expect(spawned.map((spec) => spec.scopeId)).toEqual(["two"]);

    const failedFork = forkOf(ledger, "batch:0");
    expect(failedFork.status).toBe(READY);
    expect(failedFork.outcome).toBe(FAILED);
    expect(failedFork.reason).toBe("did not start: spawn refused");

    // The surviving fork is registered and left running for its child.
    const startedFork = forkOf(ledger, "batch:1");
    expect(startedFork.status).toBe(RUNNING);
    expect(startedFork.intent).toBe("audit the second seam");
  });
});
