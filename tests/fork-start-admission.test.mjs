// Fork-start admission: the child's first request is the parent's context
// plus its receipt. A known window refuses the batch before any bracket is
// registered; unknown evidence passes exactly as join admission does.

import { describe, expect, test } from "bun:test";

import { createBracketLedger, forkOf } from "../src/scope/forkjoin.mjs";
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
    scopeId: "f1",
    dafny_pseudo_code: "audit one seam",
    budget: {},
    time: 60,
    targets: ["src/parser.mjs"],
    ...overrides,
  };
}

function callWith(...forks) {
  return { id: "f1", arguments: { forks } };
}

describe("a fork start that a known window cannot hold", () => {
  test("is refused before any bracket or spawner", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationFor(ledger, {
      currentContextTokens: () => 900,
      forkWindowPort: () => 1_000,
      forkReservePort: () => 0,
      forkMarginPort: () => 0,
      childSpawnPort: () => (spec) => spawned.push(spec),
    });
    const out = handleForkCall(station, callWith(forkArgs()));

    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("FORK_CONTEXT_EXCEEDED");
    expect(out.details.index).toBe(0);
    expect(out.details.limit).toBe(1_000);
    expect(out.details.projected).toBeGreaterThan(999);
    expect(out.details.admission).toBe("JOIN_CONTEXT_EXCEEDED");
    expect(spawned).toEqual([]);
    expect(ledger.order).toEqual([]);
  });

  test("names the failing item in a batch and registers nothing", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationFor(ledger, {
      forkWindowPort: () => 10_000,
      forkReservePort: () => 0,
      forkMarginPort: () => 0,
      childSpawnPort: () => (spec) => spawned.push(spec),
    });
    const out = handleForkCall(
      station,
      callWith(
        forkArgs({ scopeId: "small" }),
        forkArgs({ scopeId: "huge", dafny_pseudo_code: "x".repeat(20_000) }),
      ),
    );

    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("FORK_CONTEXT_EXCEEDED");
    expect(out.details.index).toBe(1);
    expect(spawned).toEqual([]);
    expect(ledger.order).toEqual([]);
  });
});

describe("a fork start with room", () => {
  test("registers the bracket and spawns once", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationFor(ledger, {
      forkWindowPort: () => 1_000_000,
      forkReservePort: () => 0,
      forkMarginPort: () => 0,
      childSpawnPort: () => (spec) => spawned.push(spec),
    });
    const out = handleForkCall(station, callWith(forkArgs()));

    expect(out.isError).toBeUndefined();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].forkId).toBe("f1");
    expect(spawned[0].receipt.startsWith("You are the child of fork f1,")).toBe(true);
    expect(ledger.order).toEqual(["f1"]);
  });
});

describe("evidence that cannot prove a refusal", () => {
  test("an unknown window passes", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationFor(ledger, {
      currentContextTokens: () => 900,
      forkWindowPort: () => null,
      forkReservePort: () => 0,
      forkMarginPort: () => 0,
      childSpawnPort: () => (spec) => spawned.push(spec),
    });
    const out = handleForkCall(station, callWith(forkArgs()));

    expect(out.isError).toBeUndefined();
    expect(spawned).toHaveLength(1);
  });

  test("an unmeasured watermark is not treated as zero", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationFor(ledger, {
      currentContextTokens: () => {
        throw new Error("no meter");
      },
      forkWindowPort: () => 1_000,
      forkReservePort: () => 0,
      forkMarginPort: () => 0,
      childSpawnPort: () => (spec) => spawned.push(spec),
    });
    const out = handleForkCall(station, callWith(forkArgs()));

    expect(out.isError).toBeUndefined();
    expect(spawned).toHaveLength(1);
  });

  test("a blocked checkpoint needs no admission and spawns nothing", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationFor(ledger, {
      currentContextTokens: () => 900,
      forkWindowPort: () => 1_000,
      forkReservePort: () => 0,
      forkMarginPort: () => 0,
      childSpawnPort: () => (spec) => spawned.push(spec),
    });
    const out = handleForkCall(station, callWith(forkArgs({ blocked: true })));

    expect(out.isError).toBeUndefined();
    expect(spawned).toEqual([]);
    expect(ledger.order).toEqual(["f1"]);
    expect(forkOf(ledger, "f1").status).toBe("blocked");
  });
});
