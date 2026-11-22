// Reusing a scope id amends that scope instead of opening a duplicate.
//
// These cases stop at the station handler: the child session is a fake that
// records the specs it was handed, so the assertions can see both the ledger
// record and the receipt the next generation would read.

import { describe, expect, test } from "bun:test";

import {
  READY,
  createBracketLedger,
  forkOf,
  markReady,
  readyChildren,
  registerFork,
  takeReady,
} from "../src/scope/forkjoin.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";

const STATE = () => ({
  scopes: [],
  autopilot: false,
  relay: { generation: 0, fullFlow: false },
});

function item(overrides = {}) {
  return {
    scopeId: "worker",
    intent: "first",
    blocked: false,
    budget: { read: 2 },
    targets: ["src/worker.mjs"],
    ...overrides,
  };
}

function harness() {
  const ledger = createBracketLedger();
  const spawned = [];
  const station = {
    state: STATE(),
    forkLedgerPort: () => ledger,
    childSpawnPort: () => (spec) => {
      spawned.push(spec);
    },
  };
  const fork = (overrides = {}, id = "call-fork") =>
    handleForkCall(station, { id, arguments: { forks: [item(overrides)] } });
  return { ledger, spawned, station, fork };
}

describe("reuse while running", () => {
  test("amends budget and queues the new requirement", () => {
    const { ledger, spawned, fork } = harness();
    const first = fork({ budget: { read: 2 } }, "call-1");
    expect(first.details.started).toHaveLength(1);
    const record = forkOf(ledger, "call-1");

    const second = fork({ intent: "more", budget: { read: 1 } }, "call-2");
    expect(spawned).toHaveLength(1);
    expect(second.content[0].text).toContain("Amended");
    expect(second.details.amended).toEqual(["call-1"]);
    expect(record.budget.read).toBe(3);
    expect(record.remaining.read).toBe(3);
    expect(record.requirements).toEqual(["more"]);
  });

  test("accepts budget without an intent", () => {
    const { ledger, fork } = harness();
    fork({}, "call-1");
    const record = forkOf(ledger, "call-1");
    const before = record.requirements.length;
    const second = fork({ intent: undefined, budget: { read: 1 } }, "call-2");
    expect(second.content[0].text).not.toContain("needs a non-empty");
    expect(record.budget.read).toBe(3);
    expect(record.requirements.length).toBe(before);
  });

  test("refuses blocked:true on a running scope", () => {
    const { fork } = harness();
    fork({}, "call-1");
    const second = fork({ blocked: true, intent: "stop" }, "call-2");
    expect(second.details.failed).toEqual(["call-1"]);
    expect(second.content[0].text).toContain("cannot be marked blocked");
  });
});

describe("reuse while blocked", () => {
  test("blocked:false revives and spawns with the standing intent", () => {
    const { ledger, spawned, fork } = harness();
    fork({ blocked: true }, "call-1");
    expect(spawned).toHaveLength(0);
    const record = forkOf(ledger, "call-1");

    const second = fork({ blocked: false, intent: "go" }, "call-2");
    expect(record.status).toBe("running");
    expect(spawned).toHaveLength(1);
    expect(second.details.revived).toEqual(["call-1"]);
    expect(spawned[0].receipt).toContain("first");
    expect(record.requirements).toEqual(["go"]);
  });

  test("blocked:true only queues the requirement", () => {
    const { ledger, spawned, fork } = harness();
    fork({ blocked: true }, "call-1");
    const record = forkOf(ledger, "call-1");
    const second = fork({ blocked: true, intent: "later" }, "call-2");
    expect(record.status).toBe("blocked");
    expect(spawned).toHaveLength(0);
    expect(second.details.amended).toEqual(["call-1"]);
    expect(record.requirements).toEqual(["later"]);
  });
});

describe("reuse after the child closed", () => {
  test("a ready record is superseded and the next generation carries its record", () => {
    const { ledger, spawned, fork } = harness();
    fork({}, "call-1");
    markReady(ledger, "call-1", { record: "first" });
    expect(readyChildren(ledger, "root")).toEqual(["call-1"]);

    const second = fork({ intent: "again", budget: { read: 1 } }, "call-2");
    const old = forkOf(ledger, "call-1");
    expect(old.supersededAt).not.toBeNull();
    expect(readyChildren(ledger, "root")).toEqual([]);
    expect(spawned).toHaveLength(2);
    const next = forkOf(ledger, "call-2");
    expect(next.status).toBe("running");
    expect(next.generation).toBe(2);
    expect(next.scopeId).toBe("worker");
    expect(second.details.continued).toEqual(["call-2"]);
    expect(spawned[1].receipt).toContain("Continuing scope worker — generation 2");
    expect(spawned[1].receipt).toContain("first");
  });

  test("a joined record continues in a new generation", () => {
    const { ledger, spawned, fork } = harness();
    fork({}, "call-1");
    markReady(ledger, "call-1", { record: "done" });
    const taken = takeReady(ledger, { ownerId: "root" });
    expect(taken.ok).toBe(true);
    expect(taken.fork.status).toBe("joined");

    fork({ intent: "continue", budget: { read: 1 } }, "call-2");
    const next = forkOf(ledger, "call-2");
    expect(next.generation).toBe(2);
    expect(next.continuesForkId).toBe("call-1");
    expect(spawned).toHaveLength(2);
  });

  test("a failed record continues and shows the reason", () => {
    const { ledger, spawned, fork } = harness();
    fork({}, "call-1");
    markReady(ledger, "call-1", { ok: false, reason: "boom" });
    fork({ intent: "retry", budget: { read: 1 } }, "call-2");
    const next = forkOf(ledger, "call-2");
    expect(next.generation).toBe(2);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].receipt).toContain("boom");
  });
});

describe("reuse inside one batch", () => {
  test("the second item amends the first record", () => {
    const { ledger, spawned, station } = harness();
    const out = handleForkCall(station, {
      id: "call-batch",
      arguments: {
        forks: [
          item({ scopeId: "worker", intent: "first", budget: { read: 2 } }),
          item({ scopeId: "worker", intent: "second", budget: { read: 1 } }),
        ],
      },
    });
    expect(spawned).toHaveLength(1);
    expect(out.details.started).toEqual(["call-batch:0"]);
    expect(out.details.amended).toEqual(["call-batch:0"]);
    const record = forkOf(ledger, "call-batch:0");
    expect(record.requirements).toEqual(["second"]);
    expect(record.budget.read).toBe(3);
  });
});

describe("reuse refusal", () => {
  test("a new scope without an intent is refused", () => {
    const { ledger, spawned, fork } = harness();
    const out = fork({ scopeId: "fresh", intent: "   " }, "call-blank");
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("MISSING_INTENT");
    expect(spawned).toHaveLength(0);
    expect(ledger.order).toHaveLength(0);
  });

  test("another owner's name is refused", () => {
    const { ledger, station } = harness();
    registerFork(ledger, {
      forkId: "theirs",
      scopeId: "worker",
      ownerId: "other",
      intent: "not yours",
      depth: 0,
      budget: { read: 1 },
      time: 30,
    });
    const out = handleForkCall(station, {
      id: "call-foreign",
      arguments: { forks: [item({ scopeId: "worker" })] },
    });
    expect(out.details.code).toBe("FOREIGN_SCOPE_ID");
  });

  test("an empty increment with no remaining budget is refused", () => {
    const { ledger, fork } = harness();
    fork({}, "call-1");
    markReady(ledger, "call-1", { record: "done" });
    const record = forkOf(ledger, "call-1");
    record.remaining = {};
    const out = fork({ budget: {}, intent: "more" }, "call-2");
    expect(out.details.failed).toEqual(["call-1"]);
    expect(out.content[0].text).toContain("changed nothing");
  });
});
