// `scope_fork` only creates. A sibling name that is already taken is
// renamed, never amended, so every fork keeps its 1:1 pairing with a join.

import { describe, expect, test } from "bun:test";

import { createBracketLedger } from "../src/scope/forkjoin.mjs";
import { decideRegister, validateFork } from "../src/station/domain/fork-join.mjs";
import { forkParameters } from "../src/tools/descriptions.mjs";

const item = {
  scopeId: "worker",
  fsm: "do the work",
  profession: "You are a careful worker like Ada Lovelace.",
  n: 2,
  budget: { read: 2 },
  targets: ["src/a.mjs"],
};

describe("fork validation", () => {
  test("a new scope needs a non-empty fsm", () => {
    expect(validateFork(item).ok).toBe(true);
    const blank = validateFork({ ...item, fsm: "   " });
    expect(blank.ok).toBe(false);
    expect(blank.code).toBe("INVALID_FSM");
  });

  test("the schema requires fsm and no longer carries blocked", () => {
    const schema = forkParameters.properties.forks.items;
    expect(schema.required).toContain("fsm");
    expect(schema.required).not.toContain("blocked");
    expect(schema.properties.blocked).toBeUndefined();
  });
});

describe("decideRegister renames instead of amending", () => {
  test("a free name registers as written", () => {
    const out = decideRegister({
      items: [validateFork(item)],
      forks: [],
      parentForkId: null,
      hasSpawner: true,
    });
    expect(out.ok).toBe(true);
    expect(out.items[0]).toMatchObject({
      action: "register",
      scopeId: "worker",
      path: "/worker",
    });
  });

  test("a taken sibling name gains the lowest free suffix", () => {
    const out = decideRegister({
      items: [validateFork(item)],
      forks: [
        {
          forkId: "f1",
          scopeId: "worker",
          parentForkId: null,
          path: "/worker",
          status: "running",
        },
      ],
      parentForkId: null,
      hasSpawner: true,
    });
    expect(out.ok).toBe(true);
    expect(out.items[0].action).toBe("register");
    expect(out.items[0].scopeId).toBe("worker-2");
    expect(out.items[0].path).toBe("/worker-2");
    // No amendment target: the earlier scope is a different scope.
    expect(out.items[0].targetForkId).toBeUndefined();
  });

  test("a repeat inside one batch is renamed in order", () => {
    const out = decideRegister({
      items: [validateFork(item), validateFork(item)],
      forks: [],
      parentForkId: null,
      hasSpawner: true,
    });
    expect(out.items.map((entry) => entry.path)).toEqual(["/worker", "/worker-2"]);
  });

  test("the same name under two parents stays untouched", () => {
    const forks = [
      { forkId: "a", scopeId: "a", parentForkId: null, path: "/a", status: "running" },
      { forkId: "b", scopeId: "b", parentForkId: null, path: "/b", status: "running" },
      {
        forkId: "aw",
        scopeId: "worker",
        parentForkId: "a",
        path: "/a/worker",
        status: "running",
      },
    ];
    const out = decideRegister({
      items: [validateFork(item)],
      forks,
      parentForkId: "b",
      hasSpawner: true,
    });
    expect(out.items[0].scopeId).toBe("worker");
    expect(out.items[0].path).toBe("/b/worker");
  });

  test("a finished sibling still holds its name", () => {
    const out = decideRegister({
      items: [validateFork(item)],
      forks: [
        {
          forkId: "f1",
          scopeId: "worker",
          parentForkId: null,
          path: "/worker",
          status: "ready",
        },
      ],
      parentForkId: null,
      hasSpawner: true,
    });
    expect(out.items[0].scopeId).toBe("worker-2");
  });
});

describe("handleForkCall", () => {
  const stationFor = (ledger, spawned) => ({
    state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
    forkLedgerPort: () => ledger,
    childSpawnPort: () => (spec) => {
      spawned.push(spec);
    },
  });

  test("spawns each sibling under its own path", async () => {
    const { handleForkCall } = await import("../src/station/fork-controls.mjs");
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationFor(ledger, spawned);
    const out = handleForkCall(station, {
      id: "call-rename",
      arguments: { forks: [item, item] },
    });
    expect(out.isError).toBeUndefined();
    expect(spawned.map((spec) => spec.scopeId)).toEqual(["worker", "worker-2"]);
    expect(spawned.map((spec) => spec.path)).toEqual(["/worker", "/worker-2"]);
    expect(spawned[1].receipt).toContain("You are now in the scope /worker-2");
    expect(out.content[0].text).toContain("/worker-2");

    // The ledger records the address, so `scope_send` can find it later.
    const record = ledger.forks[spawned[1].forkId];
    expect(record.path).toBe("/worker-2");
    expect(record.parentForkId).toBeNull();
  });

  test("a child forked by a child is addressed under its parent", async () => {
    const { handleForkCall } = await import("../src/station/fork-controls.mjs");
    const ledger = createBracketLedger();
    const spawned = [];
    const root = stationFor(ledger, spawned);
    handleForkCall(root, {
      id: "call-root",
      arguments: { forks: [{ ...item, scopeId: "api" }] },
    });
    const parentForkId = spawned[0].forkId;
    const parentPath = ledger.forks[parentForkId].path;
    expect(parentPath).toBe("/api");

    const childStation = {
      ...stationFor(ledger, spawned),
      forkIdentityPort: () => ({ forkId: parentForkId, parentOwnerId: "root" }),
    };
    const out = handleForkCall(childStation, {
      id: "call-child",
      arguments: { forks: [item] },
    });
    expect(out.isError).toBeUndefined();
    expect(spawned[1].scopeId).toBe("worker");
    expect(spawned[1].path).toBe("/api/worker");
    expect(spawned[1].receipt).toContain("You are now in the scope /api/worker");
    expect(ledger.forks[spawned[1].forkId].parentForkId).toBe(parentForkId);
  });
});
