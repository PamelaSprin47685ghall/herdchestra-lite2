// Delivery is a nudge, not a promise. The request already sits in the queue;
// the delivery table only decides which hook to call so the target notices it.
//
// These cases pin the four branches and, above all, the property they protect:
// a finished scope keeps the record its parent will join. Answering a request
// must not rewrite that record, or a join would hand over a different report
// than the one the child sealed.

import { describe, expect, test } from "bun:test";

import {
  READY,
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import {
  createForkRegistry,
  outcomeOf,
  setOutcome,
} from "../src/scope/fork-registry.mjs";
import {
  clearRuntime,
  currentRequest,
  enqueueRequest,
  markRequestDelivered,
  registerRuntime,
  runtimeOf,
  runtimeTable,
} from "../src/scope/request-queue.mjs";
import { listActiveScopePaths } from "../src/scope/path.mjs";
import {
  handleReplyToolCall,
  handleRequestToolCall,
} from "../src/station/request-controls.mjs";

const STATE = {
  scopes: [],
  autopilot: false,
  relay: { generation: 0, fullFlow: false },
};

function ledgerWith(path) {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId: "f-worker",
    ownerId: "root",
    levelKey: "L0",
    fsm: "task /worker",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a worker.",
  });
  expect(registered.ok).toBe(true);
  registered.fork.path = path;
  return ledger;
}

function stationFor(ledger, identity) {
  const registry = createForkRegistry();
  return {
    state: { ...STATE },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => identity,
    registry,
    get requestRuntime() {
      return runtimeTable(registry);
    },
  };
}

function askOne(station, target, message, interrupt) {
  return handleRequestToolCall(station, {
    id: "call-req",
    arguments: { target, message, ...(interrupt === undefined ? {} : { interrupt }) },
  });
}

describe("the delivery table picks exactly one hook", () => {
  test("an idle target is woken: nothing else would make it take a turn", () => {
    const ledger = ledgerWith("/worker");
    const station = stationFor(ledger, { forkId: "f-api", path: "/api" });
    const hooks = [];
    registerRuntime(station.registry, "/worker", {
      state: "idle",
      wake: () => hooks.push("wake"),
      interrupt: () => hooks.push("interrupt"),
    });

    askOne(station, "/worker", "are you there?", true);
    // An idle scope never makes another request on its own, so the wake hook is
    // the only thing that can deliver the question to it.
    expect(hooks).toEqual(["wake"]);
    // The request is queued regardless: a missing hook would still leave it for
    // the target's next turn.
    expect(runtimeOf(station.registry, "/worker").state).toBe("idle");
    expect(currentRequest(station.registry, "/worker").message).toBe("are you there?");
  });

  test("a target parked in a join yields the join before anything else", () => {
    const ledger = ledgerWith("/worker");
    const station = stationFor(ledger, { forkId: "f-api", path: "/api" });
    const hooks = [];
    registerRuntime(station.registry, "/worker", {
      state: "running",
      parked: "join",
      yieldJoin: () => hooks.push("yieldJoin"),
      interrupt: () => hooks.push("interrupt"),
      wake: () => hooks.push("wake"),
    });

    askOne(station, "/worker", "quick question", true);
    // Yielding the join is enough: the target takes a reply turn and a later
    // request picks the ready record up again.
    expect(hooks).toEqual(["yieldJoin"]);
  });

  test("an interrupt request cuts a running beat", () => {
    const ledger = ledgerWith("/worker");
    const station = stationFor(ledger, { forkId: "f-api", path: "/api" });
    const hooks = [];
    registerRuntime(station.registry, "/worker", {
      state: "running",
      interrupt: () => hooks.push("interrupt"),
      wake: () => hooks.push("wake"),
    });

    askOne(station, "/worker", "stop and answer", true);
    expect(hooks).toEqual(["interrupt"]);
  });

  test("a soft request leaves a running target alone", () => {
    const ledger = ledgerWith("/worker");
    const station = stationFor(ledger, { forkId: "f-api", path: "/api" });
    const hooks = [];
    registerRuntime(station.registry, "/worker", {
      state: "running",
      interrupt: () => hooks.push("interrupt"),
      wake: () => hooks.push("wake"),
      yieldJoin: () => hooks.push("yieldJoin"),
    });

    askOne(station, "/worker", "when you get a chance");
    expect(hooks).toEqual([]);
  });

  test("a request to a target with no runtime entry simply queues", () => {
    const ledger = ledgerWith("/worker");
    const station = stationFor(ledger, { forkId: "f-api", path: "/api" });
    askOne(station, "/worker", "hello?");
    expect(runtimeOf(station.registry, "/worker")).toBeNull();
    // A missing hook is not a lost request: the target reads it at its own next
    // request, where the projection turns into AWAITING_REPLY.
    expect(currentRequest(station.registry, "/worker").message).toBe("hello?");
  });
});

describe("the runtime table merges and forgets", () => {
  test("going idle keeps the hooks a running phase registered", () => {
    const registry = createForkRegistry();
    const interrupt = () => {};
    registerRuntime(registry, "/worker", { state: "running", interrupt });
    registerRuntime(registry, "/worker", { state: "idle", wake: () => {} });
    const entry = runtimeOf(registry, "/worker");
    expect(entry.state).toBe("idle");
    expect(entry.interrupt).toBe(interrupt);
    expect(typeof entry.wake).toBe("function");
  });

  test("a cleared scope no longer looks wakeable", () => {
    const registry = createForkRegistry();
    registerRuntime(registry, "/worker", { state: "idle", wake: () => {} });
    expect(clearRuntime(registry, "/worker")).toBe(true);
    expect(runtimeOf(registry, "/worker")).toBeNull();
  });
});

describe("answering a request does not rewrite a finished record", () => {
  test("the sealed record and its outcome survive a reply turn", async () => {
    const ledger = ledgerWith("/worker");
    const station = stationFor(ledger, { forkId: "f-api", path: "/api" });
    const responder = {
      ...station,
      forkIdentityPort: () => ({ forkId: "f-worker", path: "/worker" }),
    };
    markReady(ledger, "f-worker", { ok: true, record: "the leak is in the parser" });
    setOutcome(station.registry, "f-worker", {
      record: "the leak is in the parser",
      failed: false,
      reason: null,
    });
    const record = forkOf(ledger, "f-worker");
    expect(record.status).toBe(READY);
    expect(listActiveScopePaths(ledger)).not.toContain("/worker");
    const sealedOutcome = outcomeOf(station.registry, "f-worker");

    // Waking a finished scope is a reply turn, not a second life. The queue is
    // written directly here: this case is about what the reply does to the
    // sealed record, not about how the question reached the target.
    registerRuntime(station.registry, "/worker", { state: "idle", wake: () => {} });
    const queued = enqueueRequest(station.registry, {
      from: "/api",
      target: "/worker",
      message: "what did you find?",
    });
    expect(queued.ok).toBe(true);
    markRequestDelivered(station.registry, "/worker");
    const replied = handleReplyToolCall(responder, {
      id: "call-rep",
      arguments: "parser.mjs:88",
    });
    expect(replied.details.result).toEqual({ ok: true });
    await expect(queued.promise).resolves.toBe("parser.mjs:88");

    // Nothing about the handed-over work moved: same status, same outcome, and
    // still one record for the parent to join.
    expect(forkOf(ledger, "f-worker").status).toBe(READY);
    expect(outcomeOf(station.registry, "f-worker")).toEqual(sealedOutcome);
  });
});
