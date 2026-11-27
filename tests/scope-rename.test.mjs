// `scope_fork` only creates. Duplicate paths (running or done,
// case-insensitive, or repeated within one batch) fail closed with
// `DUPLICATE_SCOPE_PATH` instead of renaming with `-2/-3` suffixes.

import { describe, expect, test } from "bun:test";

import { createBracketLedger } from "../src/scope/forkjoin.mjs";
import { decideRegister, validateFork } from "../src/station/domain/fork-join.mjs";
import { loadDoc } from "../src/prompts/index.mjs";

const item = {
  path: "inspector.worker",
  fsm: "do the work",
  profession: "You are a careful worker like Ada Lovelace.",
  n: 2,
  budget: { read: 2 },
  targets: ["src/a.mjs"],
};

describe("fork validation", () => {
  test("a new scope needs a non-empty fsm and path", () => {
    expect(validateFork(item).ok).toBe(true);
    const blank = validateFork({ ...item, fsm: "   " });
    expect(blank.ok).toBe(false);
    expect(blank.code).toBe("INVALID_FSM");

    const noPath = validateFork({ ...item, path: "   " });
    expect(noPath.ok).toBe(false);
    expect(noPath.code).toBe("INVALID_PATH");
  });

  test("the model-facing fork copy describes state machines and never mentions blocked", () => {
    // There is no JSON schema for a fork item any more: `scope_fork` is an api
    // method whose declaration is static. What teaches the rule is the copy, so
    // the copy is where the rule must survive.
    const doc = loadDoc("tools/fork-join");
    expect(doc["fork.fsm"]).toMatch(/state machine/i);
    expect(doc["fork.fsm"]).toMatch(/required/i);
    expect(doc["fork.path"]).toContain("fails closed");
    expect(Object.values(doc).join("\n")).not.toContain("blocked");
  });
});

describe("decideRegister fails closed on duplicate paths", () => {
  test("a free path registers as written", () => {
    const out = decideRegister({
      items: [validateFork(item)],
      forks: [],
      callerPath: "/",
      hasSpawner: true,
    });
    expect(out.ok).toBe(true);
    expect(out.items[0]).toMatchObject({
      action: "register",
      scopeId: "inspector.worker",
      path: "/inspector.worker",
      upscopePath: "/",
      callerPath: "/",
    });
  });

  test("a taken running path fails closed with DUPLICATE_SCOPE_PATH", () => {
    const out = decideRegister({
      items: [validateFork(item)],
      forks: [
        {
          forkId: "f1",
          scopeId: "inspector.worker",
          upscopeId: null,
          path: "/inspector.worker",
          status: "running",
        },
      ],
      callerPath: "/",
      hasSpawner: true,
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("DUPLICATE_SCOPE_PATH");
    expect(out.path).toBe("/inspector.worker");
    expect(out.status).toBe("running");
  });

  test("a repeat inside one batch fails closed (case-insensitive)", () => {
    const out = decideRegister({
      items: [validateFork(item), validateFork({ ...item, path: "inspector.Worker" })],
      forks: [],
      callerPath: "/",
      hasSpawner: true,
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("DUPLICATE_SCOPE_PATH");
    expect(out.index).toBe(1);
    expect(out.status).toBe("pending");
  });

  test("the same leaf name under two distinct upscopes is allowed", () => {
    const forks = [
      { forkId: "a", scopeId: "manager.a", upscopeId: null, path: "/manager.a", status: "running", safeSnapshotLeafId: "leaf-a" },
      { forkId: "b", scopeId: "manager.b", upscopeId: null, path: "/manager.b", status: "running", safeSnapshotLeafId: "leaf-b" },
      {
        forkId: "aw",
        scopeId: "inspector.worker",
        upscopeId: "manager.a",
        path: "/manager.a/inspector.worker",
        status: "running",
      },
    ];
    const out = decideRegister({
      items: [validateFork(item)],
      forks,
      callerPath: "/manager.b",
      ownerId: "b",
      hasSpawner: true,
    });
    expect(out.ok).toBe(true);
    expect(out.items[0].scopeId).toBe("inspector.worker");
    expect(out.items[0].path).toBe("/manager.b/inspector.worker");
    expect(out.items[0].upscopeId).toBe("b");
  });

  test("a finished path still holds its name and fails closed", () => {
    const out = decideRegister({
      items: [validateFork(item)],
      forks: [
        {
          forkId: "f1",
          scopeId: "inspector.worker",
          upscopeId: null,
          path: "/inspector.worker",
          status: "ready",
        },
      ],
      callerPath: "/",
      hasSpawner: true,
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe("DUPLICATE_SCOPE_PATH");
    expect(out.status).toBe("done");
  });
});

describe("handleForkCall", () => {
  const stationFor = (ledger, spawned) => ({
    state: { autopilot: false, relay: { generation: 0, fullFlow: false } },
    forkLedgerPort: () => ledger,
    childSpawnPort: () => (spec) => {
      spawned.push(spec);
    },
  });

  test("refuses duplicate paths in one batch before spawning anything", async () => {
    const { handleForkCall } = await import("../src/station/fork-controls.mjs");
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationFor(ledger, spawned);
    const out = handleForkCall(station, {
      id: "call-dup",
      arguments: { forks: [item, item] },
    });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("DUPLICATE_SCOPE_PATH");
    expect(spawned).toHaveLength(0);
    expect(ledger.order).toHaveLength(0);
  });

  test("a subscope forked by a subscope is addressed under its caller", async () => {
    const { handleForkCall } = await import("../src/station/fork-controls.mjs");
    const ledger = createBracketLedger();
    const spawned = [];
    const root = stationFor(ledger, spawned);
    handleForkCall(root, {
      id: "call-root",
      arguments: { forks: [{ ...item, path: "devops.api" }] },
    });
    const parentForkId = spawned[0].forkId;
    const parentPath = ledger.forks[parentForkId].path;
    expect(parentPath).toBe("/devops.api");

    const childStation = {
      ...stationFor(ledger, spawned),
      forkIdentityPort: () => ({ forkId: parentForkId, parentOwnerId: "root" }),
    };
    const out = handleForkCall(childStation, {
      id: "call-child",
      arguments: { forks: [item] },
    });
    expect(out.isError).toBeUndefined();
    expect(spawned[1].scopeId).toBe("inspector.worker");
    expect(spawned[1].path).toBe("/devops.api/inspector.worker");
    expect(spawned[1].receipt).toContain("You are now in the scope /devops.api/inspector.worker");
    expect(ledger.forks[spawned[1].forkId].upscopeId).toBe(parentForkId);
  });
});
