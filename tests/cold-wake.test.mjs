// scope_request reaches a stopped scope without changing what it is.
//
// A scope that finished stays addressable: a live idle handle answers in place,
// and a branch the host can still resume answers through a one-shot wake. What
// the wake must never do is change the record or leave a new handle behind — a
// live scope stays live, a dead one stays dead.

import { describe, expect, test } from "bun:test";

import {
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
  takeReady,
} from "../src/scope/forkjoin.mjs";
import { createForkRegistry } from "../src/scope/fork-registry.mjs";
import { pendingRequestCount, runtimeTable } from "../src/scope/request-queue.mjs";
import { createState } from "../src/scope/state.mjs";
import { handleRequestToolCall } from "../src/station/request-controls.mjs";

function ledgerWith(outcome) {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId: "f1",
    ownerId: "root",
    levelKey: "L0",
    fsm: "task",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a worker.",
  });
  expect(registered.ok).toBe(true);
  registered.fork.path = "/probe";
  markReady(ledger, "f1", outcome);
  expect(takeReady(ledger, { ownerId: "root", levelKey: "L0" }).ok).toBe(true);
  return ledger;
}

function stationFor(ledger, registry) {
  return {
    state: createState(),
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => null,
    registry,
    get requestRuntime() {
      return runtimeTable(registry);
    },
  };
}

function call(target) {
  return { id: "call#0", frameId: "call", arguments: { target, message: "are you there?" } };
}

describe("waking a stopped scope", () => {
  test("a stopped scope with no handle settles the caller instead of parking", () => {
    const ledger = ledgerWith({ ok: true, record: "done" });
    const registry = createForkRegistry();
    const result = handleRequestToolCall(stationFor(ledger, registry), call("/probe"));
    expect(result?.isError).toBe(true);
    expect(result?.details?.code).toBe("REQUEST_UNREACHABLE");
    // The queue is settled: no request survives a target that cannot answer.
    expect(pendingRequestCount(registry, "/probe")).toBe(0);
    // The record is untouched by the refusal.
    expect(forkOf(ledger, "f1").status).toBe("joined");
  });

  test("a failed record is refused before it is ever queued", () => {
    const ledger = ledgerWith({ ok: false, reason: "no session", record: "" });
    const registry = createForkRegistry();
    const result = handleRequestToolCall(stationFor(ledger, registry), call("/probe"));
    expect(result?.isError).toBe(true);
    expect(result?.details?.code).toBe("REQUEST_UNREACHABLE");
    expect(registry.requests?.get?.("/probe") ?? []).toHaveLength(0);
  });
});
