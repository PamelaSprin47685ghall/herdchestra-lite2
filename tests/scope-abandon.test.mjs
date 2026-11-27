// scope_abandon gracefully interrupts a running subscope at any exact path
// (never `/` or self), forcing its next turn into `ABANDONED` mode where only
// `scope_return` is bound. It does not cascade to other scopes, is idempotent
// if already abandoning, and an ABANDONED scope_return ignores the oath and
// delivers immediately without rewinding.

import { describe, expect, test } from "bun:test";

import { isFreeTool } from "../src/scope/turns.mjs";
import { CONTROL_TOOLS, createState } from "../src/scope/state.mjs";
import {
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import { projectCapabilities } from "../src/station/domain/capabilities.mjs";
import { handleAbandonCall, handleReturnCall } from "../src/station/fork-controls.mjs";

function ledgerWith({ forkId = "f1", path = "/probe", ownerId = "root", status = "running" } = {}) {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId,
    ownerId,
    path,
    upscopePath: "/",
    callerPath: "/",
    levelKey: "L0",
    fsm: "stuck task",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a worker.",
  });
  expect(registered.ok).toBe(true);
  if (status !== "running") {
    markReady(ledger, forkId, { ok: true });
  }
  return ledger;
}

function stationFor(ledger, { selfPath = "/", identity = null, interrupted = [] } = {}) {
  return {
    state: createState(),
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => identity,
    selfScopePath: () => selfPath,
    interruptScopePort: (forkId) => interrupted.push(forkId),
    persist: () => true,
  };
}

describe("scope_abandon", () => {
  test("sets abandonRequested, calls interruptScopePort, does not cascade, and is idempotent", () => {
    const ledger = ledgerWith({ forkId: "f1", path: "/probe" });
    registerFork(ledger, {
      forkId: "f2",
      ownerId: "f1",
      path: "/probe/child",
      upscopeId: "f1",
      upscopePath: "/probe",
      callerPath: "/probe",
      levelKey: "L1",
      fsm: "nested task",
      depth: 1,
      budget: { read: 1 },
      profession: "You are a worker.",
    });
    const interrupted = [];
    const station = stationFor(ledger, { interrupted });

    const first = handleAbandonCall(station, {
      id: "abandon-1",
      arguments: { target: "/probe", reason: "pivot" },
    });
    expect(first?.isError).toBeUndefined();
    expect(first?.details?.result).toEqual({ ok: true, target: "/probe" });
    const record = forkOf(ledger, "f1");
    expect(record.status).toBe("running");
    expect(record.abandonRequested).toBe(true);
    expect(record.abandonedBy).toBe("/");
    expect(record.abandonReason).toBe("pivot");
    expect(interrupted).toEqual(["f1"]);
    // Does not cascade to child scopes.
    expect(forkOf(ledger, "f2").status).toBe("running");
    expect(forkOf(ledger, "f2").abandonRequested).toBe(false);

    // Idempotent if already abandoning (does not interrupt twice).
    const second = handleAbandonCall(station, {
      id: "abandon-2",
      arguments: { target: "/probe" },
    });
    expect(second?.isError).toBeUndefined();
    expect(second?.details?.result).toEqual({
      ok: true,
      target: "/probe",
      alreadyAbandoning: true,
    });
    expect(interrupted).toEqual(["f1"]);
  });

  test("allows abandoning any running scope (even one owned by another scope)", () => {
    const ledger = ledgerWith({ forkId: "f1", path: "/probe", ownerId: "other-caller" });
    const interrupted = [];
    const station = stationFor(ledger, {
      selfPath: "/sibling",
      identity: { forkId: "f-sib", path: "/sibling" },
      interrupted,
    });
    const out = handleAbandonCall(station, {
      id: "abandon-cross",
      arguments: { target: "/probe", reason: "superseded" },
    });
    expect(out?.isError).toBeUndefined();
    expect(forkOf(ledger, "f1").abandonRequested).toBe(true);
    expect(forkOf(ledger, "f1").abandonedBy).toBe("/sibling");
    expect(interrupted).toEqual(["f1"]);
  });

  test("refuses /, self, unknown path, and already done scopes", () => {
    const ledger = ledgerWith({ forkId: "f1", path: "/probe" });
    const rootStation = stationFor(ledger);
    expect(
      handleAbandonCall(rootStation, { id: "a-root", arguments: { target: "/" } })?.details?.code,
    ).toBe("CANNOT_ABANDON_ROOT");
    expect(
      handleAbandonCall(rootStation, { id: "a-missing", arguments: { target: "/nope" } })?.details?.code,
    ).toBe("ABANDON_UNKNOWN_TARGET");

    const selfStation = stationFor(ledger, {
      selfPath: "/probe",
      identity: { forkId: "f1", path: "/probe" },
    });
    expect(
      handleAbandonCall(selfStation, { id: "a-self", arguments: { target: "/probe" } })?.details?.code,
    ).toBe("CANNOT_ABANDON_SELF");

    const doneLedger = ledgerWith({ forkId: "f1", path: "/probe", status: "ready" });
    expect(
      handleAbandonCall(stationFor(doneLedger), { id: "a-done", arguments: { target: "/probe" } })?.details?.code,
    ).toBe("SCOPE_ALREADY_DONE");
  });

  test("ABANDONED scope_return ignores oath and delivers immediately without rewinding", () => {
    const ledger = ledgerWith({ forkId: "f1", path: "/probe" });
    handleAbandonCall(stationFor(ledger), {
      id: "abandon-1",
      arguments: { target: "/probe", reason: "pivot" },
    });
    let capturedOutcome = null;
    const childStation = {
      ...stationFor(ledger, { selfPath: "/probe", identity: { forkId: "f1", path: "/probe" } }),
      contextMessages: () => [],
      setChildOutcome: (_id, outcome) => {
        capturedOutcome = outcome;
      },
      persistLedger: () => true,
    };
    const ret = handleReturnCall(childStation, {
      id: "ret-1",
      arguments: {
        dafny: "Partial findings before abandon.",
        signed_sealed_hands_off_nothing_left_on_the_table: "unfinished",
      },
    });
    expect(ret?.isError).toBeUndefined();
    expect(ret?.details?.returned).toBe(true);
    expect(ret?.details?.rewind).toBeUndefined();
    expect(ret?.details?.stopLoop).toBe(true);
    const record = forkOf(ledger, "f1");
    expect(record.status).toBe("ready");
    expect(record.outcome).toBe("ok");
    expect(record.abandonRequested).toBe(true);
    expect(capturedOutcome?.abandoned).toBe(true);
    expect(capturedOutcome?.abandonedBy).toBe("/");
    expect(capturedOutcome?.abandonReason).toBe("pivot");
  });

  test("is a free control verb bound in every ordinary mode", () => {
    expect(CONTROL_TOOLS.has("scope_abandon")).toBe(true);
    expect(isFreeTool("scope_abandon")).toBe(true);
    const projection = projectCapabilities({
      isChild: false,
      autopilot: false,
    });
    expect(projection.tools).toContain("scope_abandon");
  });
});
