// scope_abandon closes a child that will not return.
//
// The failure mode it removes: a forked scope that never calls scope_return
// leaves the parent's join parked forever, and scope_return refuses while a
// child is unreceived. One verb closes the bracket, stops the agent, settles
// every caller waiting on it, and leaves a record the join can report.

import { describe, expect, test } from "bun:test";

import { isFreeTool } from "../src/scope/turns.mjs";
import { CONTROL_TOOLS, createState } from "../src/scope/state.mjs";
import {
  createBracketLedger,
  forkOf,
  registerFork,
  takeReady,
  unreceivedChildren,
} from "../src/scope/forkjoin.mjs";
import { createForkRegistry } from "../src/scope/fork-registry.mjs";
import { listAddressableScopePaths } from "../src/scope/path.mjs";
import { enqueueRequest, pendingRequestCount } from "../src/scope/request-queue.mjs";
import { projectCapabilities } from "../src/station/domain/capabilities.mjs";
import { handleAbandonCall } from "../src/station/fork-controls.mjs";

function ledgerWith(ownerId = "root") {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId: "f1",
    ownerId,
    levelKey: "L0",
    fsm: "stuck task",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a worker.",
  });
  expect(registered.ok).toBe(true);
  registered.fork.path = "/probe";
  return ledger;
}

function stationFor(ledger, registry, stopped = []) {
  return {
    state: createState(),
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => null,
    forkWaitPort: () => ({ registry, ledger }),
    registry,
    selfScopePath: () => "/",
    abortChildrenPort: (liveIds) => stopped.push(...liveIds),
    persist: () => true,
  };
}

describe("scope_abandon", () => {
  test("closes a running child, stops it, and settles every waiter", async () => {
    const ledger = ledgerWith();
    const registry = createForkRegistry();
    const queued = enqueueRequest(registry, {
      from: "/",
      target: "/probe",
      message: "are you there?",
    });
    const stopped = [];
    const result = handleAbandonCall(stationFor(ledger, registry, stopped), {
      id: "abandon-1",
      arguments: { target: "/probe" },
    });
    expect(result?.isError).toBeUndefined();
    expect(result?.details?.result?.abandoned).toContain("/probe");
    const record = forkOf(ledger, "f1");
    expect(record.status).not.toBe("running");
    expect(record.outcome).toBe("failed");
    expect(String(record.reason)).toContain("abandoned by /");
    expect(stopped).toContain("f1");
    // The caller parked on the request settles instead of waiting forever.
    await expect(queued.promise).rejects.toThrow();
    expect(pendingRequestCount(registry, "/probe")).toBe(0);
    // A parked join takes the failure, and the address stops being offered.
    const taken = takeReady(ledger, { ownerId: "root" });
    expect(taken.ok).toBe(true);
    expect(taken.fork.outcome).toBe("failed");
    expect(listAddressableScopePaths(ledger)).not.toContain("/probe");
    expect(unreceivedChildren(ledger, "root")).toHaveLength(0);
  });

  test("refuses an unknown path and a child of another scope", () => {
    const ledger = ledgerWith();
    const registry = createForkRegistry();
    const station = stationFor(ledger, registry);
    expect(
      handleAbandonCall(station, { id: "a1", arguments: { target: "/nope" } })?.details?.code,
    ).toBe("ABANDON_UNKNOWN_TARGET");
    const foreign = ledgerWith("someone-else");
    expect(
      handleAbandonCall(stationFor(foreign, createForkRegistry()), {
        id: "a2",
        arguments: { target: "/probe" },
      })?.details?.code,
    ).toBe("ABANDON_NOT_OWNED");
  });

  test("is a free control verb bound in every ordinary mode", () => {
    expect(CONTROL_TOOLS.has("scope_abandon")).toBe(true);
    expect(isFreeTool("scope_abandon")).toBe(true);
    const projection = projectCapabilities({
      isChild: false,
      autopilot: false,
      activePaths: ["/"],
    });
    expect(projection.tools).toContain("scope_abandon");
  });
});
