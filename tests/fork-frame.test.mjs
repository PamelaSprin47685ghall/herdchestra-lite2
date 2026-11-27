// One control call, two identities.
//
// The js runtime mints a synthetic call id (`<frame>#<index>`) so one script
// can issue several control calls. Only the frame id names an assistant tool
// call in the journal, so the fork spec and the join receipt must read the
// frame — and a scope that never produced a session must leave the address
// book rather than park a caller forever.

import { describe, expect, test } from "bun:test";

import { createBracketLedger, forkOf, markReady, registerFork, takeReady } from "../src/scope/forkjoin.mjs";
import { findScopeByPath } from "../src/scope/path.mjs";
import { createState } from "../src/scope/state.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";
import { handleAbandonCall } from "../src/station/abandon-controls.mjs";
import { createTools } from "../src/tools/catalog.mjs";
import { textResult } from "../src/tools/results.mjs";

const ITEM = {
  path: "inspector.probe",
  fsm: "x",
  profession: "You are a probe engineer like Barbara Liskov.",
  n: 1,
  budget: { read: 1 },
  targets: ["src/parser.mjs"],
};

function forkStation() {
  const ledger = createBracketLedger();
  const spawned = [];
  const station = {
    state: createState(),
    forkLedgerPort: () => ledger,
    childSpawnPort: () => (spec) => spawned.push(spec),
  };
  return { spawned, station };
}

function joinedLedger(outcome) {
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
  registered.fork.path = "/inspector.probe";
  markReady(ledger, "f1", outcome);
  const taken = takeReady(ledger, { ownerId: "root", levelKey: "L0" });
  expect(taken.ok).toBe(true);
  return ledger;
}

describe("the journal frame of a control call", () => {
  test("the js dispatch hands the enclosing frame to the control ticket", async () => {
    const seen = [];
    const station = {
      beginJsCall: () => ({ mode: "CHILD", tools: ["scope_fork"], state: {}, signature: "x" }),
      finishJsCall: () => {},
      executeFork: (toolCallId, _params, _ctx, frameId) => {
        seen.push({ toolCallId, frameId });
        return textResult("ok", { result: { ok: true } });
      },
    };
    const [tool] = createTools({ stationFor: () => station, tickets: {} });
    await tool.execute("frame-1", { code: "await api.scope_fork({ forks: [] })" }, null, null, {});
    // The script's own id is synthetic; the frame is the tool call the journal
    // and the branch-session factory can resolve.
    expect(seen).toEqual([{ toolCallId: "frame-1#0", frameId: "frame-1" }]);
  });

  test("the spawn spec carries the enclosing assistant frame", () => {
    const { spawned, station } = forkStation();
    handleForkCall(station, { id: "call#0", frameId: "call", arguments: { forks: [ITEM] } });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].sourceToolCallId).toBe("call");
  });

  test("a call that is its own frame keeps its own id", () => {
    const { spawned, station } = forkStation();
    handleForkCall(station, { id: "call", arguments: { forks: [ITEM] } });
    expect(spawned[0].sourceToolCallId).toBe("call");
  });
});

describe("the address book", () => {
  test("a joined scope whose outcome failed is still found by path and cannot be abandoned", () => {
    const ledger = joinedLedger({ ok: false, reason: "NO_FORK_FRAME: no frame", record: "" });
    expect(forkOf(ledger, "f1").outcome).toBe("failed");
    expect(findScopeByPath(ledger, "/inspector.probe")?.forkId).toBe("f1");
    const station = {
      state: createState(),
      forkLedgerPort: () => ledger,
      forkIdentityPort: () => null,
    };
    const result = handleAbandonCall(station, {
      id: "call#1",
      frameId: "call",
      arguments: { target: "/inspector.probe" },
    });
    expect(result?.isError).toBe(true);
    expect(result?.details?.code).toBe("SCOPE_ALREADY_DONE");
  });

  test("a joined scope that returned keeps its address", () => {
    const ledger = joinedLedger({ ok: true, record: "done" });
    expect(findScopeByPath(ledger, "/inspector.probe")?.forkId).toBe("f1");
  });
});
