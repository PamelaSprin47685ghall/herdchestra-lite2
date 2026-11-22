import { describe, expect, test } from "bun:test";

import {
  READY,
  JOINED,
  FAILED,
  RUNNING,
  abandon,
  assertPairing,
  createBracketLedger,
  forkOf,
  hasOpenChildren,
  levelOrder,
  markReady,
  openChildren,
  readyChildren,
  registerFork,
  reparentOrphans,
  statsOf,
  takeReady,
} from "../src/scope/forkjoin.mjs";

function fork(ledger, forkId, ownerId = "root", depth = 0, levelKey = "L0") {
  const result = registerFork(ledger, {
    forkId,
    ownerId,
    levelKey,
    intent: `task ${forkId}`,
    depth,
  });
  expect(result.ok).toBe(true);
  return result.fork;
}

describe("registration", () => {
  test("opens a bracket at the next depth", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, "f1", "root", 0);
    expect(record.depth).toBe(0);
    expect(record.childDepth).toBe(1);
    expect(record.status).toBe(RUNNING);
    expect(record.openSeq).toBe(1);
    expect(forkOf(ledger, "f1")).toBe(record);
  });

  test("refuses a duplicate fork id", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    const again = registerFork(ledger, {
      forkId: "f1",
      ownerId: "root",
      intent: "again",
      depth: 0,
    });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("DUPLICATE_FORK");
  });

  test("refuses an empty intent on a new scope", async () => {
    const { handleForkCall } = await import("../src/station/fork-controls.mjs");
    const item = {
      scopeId: "probe",
      intent: "   ",
      blocked: false,
      budget: { read: 1 },
      targets: ["src/parser.mjs"],
    };
    const ledger = createBracketLedger();
    const spawned = [];
    const station = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
      forkLedgerPort: () => ledger,
      childSpawnPort: () => (spec) => {
        spawned.push(spec);
      },
    };
    const result = handleForkCall(station, {
      id: "call-empty-intent",
      arguments: { forks: [item] },
    });
    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("MISSING_INTENT");
    expect(result.details.scopeId).toBe("probe");
    expect(result.content[0].text).toContain("A new scope needs a non-empty");
    expect(spawned).toHaveLength(0);
    expect(ledger.order).toEqual([]);
  });

  test("accepts several forks in one beat", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    fork(ledger, "f2");
    fork(ledger, "f3");
    expect(ledger.order).toEqual(["f1", "f2", "f3"]);
    expect(openChildren(ledger, "root")).toEqual(["f1", "f2", "f3"]);
    expect(statsOf(ledger)).toEqual({
      forks: 3,
      running: 3,
      ready: 0,
      joined: 0,
      failed: 0,
      blocked: 0,
      levels: 0,
    });
  });
});

describe("out-of-order pairing", () => {
  test("takes the child that returned first, not the one forked first", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    fork(ledger, "f2");
    fork(ledger, "f3");
    expect(markReady(ledger, "f3").ok).toBe(true);
    const taken = takeReady(ledger, { ownerId: "root", levelKey: "L0" });
    expect(taken.ok).toBe(true);
    expect(taken.fork.forkId).toBe("f3");
    expect(taken.fork.status).toBe(JOINED);
    expect(openChildren(ledger, "root")).toEqual(["f1", "f2"]);
    expect(readyChildren(ledger, "root")).toEqual([]);
  });

  test("follows return order across several joins", () => {
    const ledger = createBracketLedger();
    for (const id of ["f1", "f2", "f3", "f4"]) fork(ledger, id);
    markReady(ledger, "f3");
    markReady(ledger, "f1");
    markReady(ledger, "f2");
    expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("f3");
    expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("f1");
    expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("f2");
    // The last child has not returned yet, so the parent cannot take it.
    expect(takeReady(ledger, { ownerId: "root" }).ok).toBe(false);
    markReady(ledger, "f4");
    expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("f4");
    expect(levelOrder(ledger, "L0")).toEqual(["f3", "f1", "f2", "f4"]);
  });

  test("returns NO_READY_CHILD instead of blocking when nothing returned", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    const taken = takeReady(ledger, { ownerId: "root" });
    expect(taken.ok).toBe(false);
    expect(taken.code).toBe("NO_READY_CHILD");
  });

  test("drops a stale queue entry left by a cancelled child", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    fork(ledger, "f2");
    markReady(ledger, "f1");
    abandon(ledger, "f1", "cancelled");
    expect(readyChildren(ledger, "root")).toEqual([]);
    markReady(ledger, "f2");
    const taken = takeReady(ledger, { ownerId: "root" });
    expect(taken.fork.forkId).toBe("f2");
    expect(assertPairing(ledger).ok).toBe(true);
  });

  test("marks a failed child as ready so the parent sees the failure", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    markReady(ledger, "f1", { ok: false, reason: "boom" });
    expect(forkOf(ledger, "f1").status).toBe(READY);
    const taken = takeReady(ledger, { ownerId: "root" });
    expect(taken.fork.outcome).toBe(FAILED);
    expect(taken.fork.reason).toBe("boom");
  });
});

describe("reparenting", () => {
  test("moves unfinished children to the grandparent in causal order", () => {
    const ledger = createBracketLedger();
    fork(ledger, "p", "root", 0);
    fork(ledger, "c1", "p", 1);
    fork(ledger, "c2", "p", 1);
    markReady(ledger, "p");
    const moved = reparentOrphans(ledger, "p", "root");
    expect(moved).toEqual({ ok: true, moved: 2, transferred: 0 });
    expect(openChildren(ledger, "root")).toEqual(["c1", "c2"]);
    expect(openChildren(ledger, "p")).toEqual([]);
    expect(forkOf(ledger, "c1").reparentedFrom).toBe("p");
    const first = takeReady(ledger, { ownerId: "root" });
    expect(first.fork.forkId).toBe("p");
    expect(assertPairing(ledger).ok).toBe(true);
  });

  test("keeps the parent ahead of its reparented children", () => {
    const ledger = createBracketLedger();
    fork(ledger, "p", "root", 0);
    fork(ledger, "c1", "p", 1);
    markReady(ledger, "p");
    reparentOrphans(ledger, "p", "root");
    markReady(ledger, "c1");
    expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("p");
    expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("c1");
  });

  test("moves ready results that were already queued for the dying owner", () => {
    const ledger = createBracketLedger();
    fork(ledger, "p", "root", 0);
    fork(ledger, "c1", "p", 1);
    markReady(ledger, "p");
    markReady(ledger, "c1");
    const moved = reparentOrphans(ledger, "p", "root");
    expect(moved.transferred).toBe(1);
    expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("p");
    expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("c1");
    expect(assertPairing(ledger).ok).toBe(true);
  });

  test("refuses to reparent to the same owner", () => {
    const ledger = createBracketLedger();
    fork(ledger, "p", "root", 0);
    const moved = reparentOrphans(ledger, "p", "p");
    expect(moved.ok).toBe(false);
    expect(moved.code).toBe("SAME_OWNER");
  });

  test("walks a two-level orphan chain up to the root", () => {
    const ledger = createBracketLedger();
    fork(ledger, "g", "root", 0);
    fork(ledger, "p", "g", 1);
    fork(ledger, "c", "p", 2);
    markReady(ledger, "p");
    markReady(ledger, "g");
    reparentOrphans(ledger, "p", "g");
    reparentOrphans(ledger, "g", "root");
    expect(openChildren(ledger, "root")).toEqual(["c"]);
    const order = [
      takeReady(ledger, { ownerId: "root" }).fork.forkId,
      takeReady(ledger, { ownerId: "root" }).fork.forkId,
    ];
    markReady(ledger, "c");
    order.push(takeReady(ledger, { ownerId: "root" }).fork.forkId);
    expect(order).toEqual(["g", "p", "c"]);
  });
});

describe("sibling order", () => {
  test("keeps levels independent", () => {
    const ledger = createBracketLedger();
    fork(ledger, "a", "root", 0, "L0");
    fork(ledger, "b", "child", 1, "L1");
    markReady(ledger, "a");
    markReady(ledger, "b");
    takeReady(ledger, { ownerId: "root", levelKey: "L0" });
    takeReady(ledger, { ownerId: "child", levelKey: "L1" });
    expect(levelOrder(ledger, "L0")).toEqual(["a"]);
    expect(levelOrder(ledger, "L1")).toEqual(["b"]);
  });
});

describe("self check", () => {
  test("passes on a consistent ledger", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    fork(ledger, "f2");
    markReady(ledger, "f1");
    takeReady(ledger, { ownerId: "root", levelKey: "L0" });
    expect(assertPairing(ledger)).toEqual({ ok: true });
  });

  test("reports a queue entry whose state moved on", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    markReady(ledger, "f1");
    ledger.forks.f1.status = JOINED;
    const check = assertPairing(ledger);
    expect(check.ok).toBe(false);
    expect(check.problems.join("\n")).toContain("in state joined");
  });

  test("reports a joined fork without a completion order", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    markReady(ledger, "f1");
    takeReady(ledger, { ownerId: "root", levelKey: "L0" });
    ledger.forks.f1.closedOrder = null;
    const check = assertPairing(ledger);
    expect(check.ok).toBe(false);
    expect(check.problems.join("\n")).toContain("no closedOrder");
  });

  test("reports an inconsistent depth", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    ledger.forks.f1.childDepth = 7;
    const check = assertPairing(ledger);
    expect(check.ok).toBe(false);
    expect(check.problems.join("\n")).toContain("depth is inconsistent");
  });

  test("reports an unknown fork in the order list", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    ledger.order.push("ghost");
    const check = assertPairing(ledger);
    expect(check.ok).toBe(false);
    expect(check.problems.join("\n")).toContain('unknown fork "ghost"');
  });
});

describe("owner queries", () => {
  test("splits open and ready children", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1", "root");
    fork(ledger, "f2", "root");
    fork(ledger, "g1", "other");
    markReady(ledger, "f1");
    expect(openChildren(ledger, "root")).toEqual(["f2"]);
    expect(readyChildren(ledger, "root")).toEqual(["f1"]);
    expect(hasOpenChildren(ledger, "root")).toBe(true);
    expect(hasOpenChildren(ledger, "other")).toBe(true);
    expect(hasOpenChildren(ledger, "nobody")).toBe(false);
  });

  test("forks, returns and joins through the station handlers", async () => {
    const { handleForkCall, handleJoinCall, handleReturnCall } = await import(
      "../src/station/fork-controls.mjs"
    );
    const ledger = createBracketLedger();
    const spawned = [];
    const station = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
      forkLedgerPort: () => ledger,
      childSpawnPort: () => (spec) => {
        spawned.push(spec);
      },
    };
    const forkOut = handleForkCall(station, {
      id: "call-f1",
      arguments: {
        forks: [
          {
            scopeId: "cache-probe",
            intent: "probe the cache",
            blocked: false,
            budget: { read: 2 },
            time: 60,
            targets: ["src/cache.mjs"],
          },
        ],
      },
    });
    expect(forkOut.isError).toBeUndefined?.();
    expect(forkOut.content[0].text).toContain("Started (1):\n- cache-probe: probe the cache");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].childDepth).toBe(1);
    expect(spawned[0].receipt).toContain("You are the child of fork cache-probe");

    const early = handleJoinCall(station, {
      id: "call-j1",
      arguments: {},
    });
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toContain("No child has returned yet");

    const child = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
      forkLedgerPort: () => ledger,
      forkIdentityPort: () => ({ forkId: "call-f1", parentOwnerId: "root" }),
    };
    const returned = handleReturnCall(child, {
      id: "call-r1",
      arguments: {},
    });
    expect(returned.isError).toBeUndefined();
    // The station queues; only the ticket's wait turns this into acceptance.
    expect(returned.content[0].text).toContain("queued for Root");
    expect(returned.details.awaitingReceipt).toBe(true);

    const joined = handleJoinCall(station, {
      id: "call-j2",
      arguments: {},
    });
    expect(joined.isError).toBeUndefined();
    expect(joined.content[0].text).toContain("[Child record — fork cache-probe]");
    expect(joined.content[0].text).toContain("Unreceived: 0.");
  });

  test("refuses a fork when no child spawner is attached", async () => {
    const { handleForkCall } = await import("../src/station/fork-controls.mjs");
    const station = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
      forkLedgerPort: () => createBracketLedger(),
    };
    const out = handleForkCall(station, {
      id: "call-f9",
      arguments: {
        forks: [
          {
            scopeId: "probe", intent: "x",
            blocked: false,
            budget: { read: 1 },
            time: 30,
            targets: ["src/parser.mjs"],
          },
        ],
      },
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("No child spawner is attached");
  });

  test("rejects a malformed fork before any state change", async () => {
    const { validateFork } = await import("../src/station/domain/fork-join.mjs");
    const state = { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } };
    const base = {
      scopeId: "probe", intent: "x",
      budget: { read: 1 },
      time: 30,
      targets: ["src/parser.mjs"],
    };
    expect(validateFork(base).ok).toBe(true);
    // An empty intent is legal for an amendment; a *new* scope rejects it in
    // the handler, where the name's existence is known.
    expect(validateFork({ ...base, intent: "  " }).ok).toBe(true);
    expect(validateFork({ ...base, intent: "  " }).intent).toBe("");
    expect(validateFork({ ...base, budget: { read: -1 } }).code).toBe("INVALID_BUDGET");
    expect(validateFork({ ...base, time: 0 }).ok).toBe(true);
    expect(validateFork({ ...base, time: 0 }).time).toBeUndefined();
    for (const targets of [undefined, null, [], ["  "], "src/parser.mjs", [42]]) {
      expect(validateFork({ ...base, targets }).code).toBe("INVALID_TARGETS");
    }
    expect(
      validateFork({ ...base, targets: [" src/parser.mjs ", "src/cache.mjs"] }).targets,
    ).toEqual(["src/parser.mjs", "src/cache.mjs"]);
  });

  test("accepts natural-language targets and keeps them", async () => {
    const { handleForkCall } = await import("../src/station/fork-controls.mjs");
    const { validateFork } = await import("../src/station/domain/fork-join.mjs");
    const targets = ["fix any defect you find", "the parts of the source that involve caching"];
    const item = {
      scopeId: "natural",
      intent: "fix defects",
      blocked: false,
      budget: { read: 1 },
      time: 30,
      targets,
    };
    const valid = validateFork(item);
    expect(valid.ok).toBe(true);
    expect(valid.targets).toEqual(targets);
    expect(validateFork({ ...item, targets: [`  ${targets[0]}  `] }).targets).toEqual([
      targets[0],
    ]);
    expect(validateFork({ ...item, targets: [...targets, "  "] }).code).toBe("INVALID_TARGETS");

    const ledger = createBracketLedger();
    const spawned = [];
    const station = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
      forkLedgerPort: () => ledger,
      childSpawnPort: () => (spec) => {
        spawned.push(spec);
      },
    };
    const out = handleForkCall(station, {
      id: "call-natural",
      arguments: { forks: [item] },
    });
    expect(out.isError).toBeUndefined();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].receipt).toContain(`Targets: ${targets.join(", ")}`);
  });

  test("hands a returning child's own children to the parent first", async () => {
    const { handleForkCall, handleReturnCall, handleJoinCall } = await import(
      "../src/station/fork-controls.mjs"
    );
    const ledger = createBracketLedger();
    const station = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
      forkLedgerPort: () => ledger,
    };
    // The root forks p, and p's own branch forks one grandchild.
    fork(ledger, "call-p", "root", 0);
    fork(ledger, "call-c1", "call-p", 1);
    const child = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
      forkLedgerPort: () => ledger,
      forkIdentityPort: () => ({
        forkId: "call-p",
        parentOwnerId: "root",
        ownScopeId: "call-p",
      }),
    };
    const returned = handleReturnCall(child, {
      id: "call-rp",
      arguments: {},
    });
    expect(returned.content[0].text).toContain("queued for Root");
    expect(returned.content[0].text).toContain("scope-2");
    expect(returned.details.awaitingReceipt).toBe(true);
    const taken = handleJoinCall(station, {
      id: "call-jp",
      arguments: {},
    });
    expect(taken.details.joined).toBe(true);
    expect(taken.content[0].text).toContain("[Child record — fork scope-1]");
    expect(taken.content[0].text).toContain("Unreceived: 1 (scope-2).");
    expect(taken.content[0].text).toContain("Call scope_join again to take the next one.");
  });

  test("refuses scope_return outside a forked child", async () => {
    const { handleReturnCall } = await import("../src/station/fork-controls.mjs");
    const station = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
      forkLedgerPort: () => createBracketLedger(),
    };
    const out = handleReturnCall(station, {
      id: "call-x",
      arguments: {},
    });
    expect(out.isError).toBe(true);
    const text = out.content[0].text;
    expect(text).toContain("NOT_A_CHILD");
    expect(text).toContain("scope_return");
    expect(text).toContain("scope_join");
  });

  test("parks a join until a child returns, then takes it", async () => {
    const { createForkRegistry, ledgerFor, notifyWaiters, waitForReady } = await import(
      "../src/host/fork-registry.mjs"
    );
    const registry = createForkRegistry();
    const ledger = ledgerFor(registry, "conversation");
    fork(ledger, "c1");
    const pending = waitForReady(registry, ledger, { ownerId: "root", levelKey: "L0" });
    // Nothing is ready yet, so the wait must still be outstanding.
    const race = await Promise.race([
      pending.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 5)),
    ]);
    expect(race).toBe("waiting");
    markReady(ledger, "c1");
    notifyWaiters(registry);
    const taken = await pending;
    expect(taken.ok).toBe(true);
    expect(taken.fork.forkId).toBe("c1");
  });

  test("a join wakes on abort without cancelling the child", async () => {
    const { createForkRegistry, ledgerFor, waitForReady } = await import(
      "../src/host/fork-registry.mjs"
    );
    const registry = createForkRegistry();
    const ledger = ledgerFor(registry, "conversation");
    fork(ledger, "c1");
    const controller = new AbortController();
    const pending = waitForReady(registry, ledger, {
      ownerId: "root",
      levelKey: "L0",
      signal: controller.signal,
    });
    controller.abort();
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("JOIN_INTERRUPTED");
    // The child survived the interruption.
    expect(forkOf(ledger, "c1").status).toBe(RUNNING);
    markReady(ledger, "c1");
    const taken = await waitForReady(registry, ledger, { ownerId: "root", levelKey: "L0" });
    expect(taken.fork.forkId).toBe("c1");
  });

  test("a return marks ready first, then parks until the parent takes it", async () => {
    const { createForkRegistry, ledgerFor, waitForJoin } = await import(
      "../src/host/fork-registry.mjs"
    );
    const registry = createForkRegistry();
    const ledger = ledgerFor(registry, "conversation");
    fork(ledger, "c1");
    const pending = waitForJoin(registry, ledger, "c1", { outcome: { failed: true, reason: "boom" } });
    // The mark is visible before the parent arrives.
    expect(forkOf(ledger, "c1").status).toBe(READY);
    expect(forkOf(ledger, "c1").outcome).toBe(FAILED);
    markReady(ledger, "c1")?.ok;
    takeReady(ledger, { ownerId: "root", levelKey: "L0" });
    const { notifyWaiters } = await import("../src/host/fork-registry.mjs");
    notifyWaiters(registry);
    const out = await pending;
    expect(out.ok).toBe(true);
    expect(out.fork.status).toBe(JOINED);
  });

  test("stores and reads a child record by fork id", async () => {
    const { createForkRegistry, clearOutcome, outcomeOf, setOutcome, statsOf } = await import(
      "../src/host/fork-registry.mjs"
    );
    const registry = createForkRegistry();
    setOutcome(registry, "c1", { record: "[read]", failed: false });
    expect(outcomeOf(registry, "c1")).toEqual({
      record: "[read]",
      failed: false,
      reason: null,
    });
    expect(outcomeOf(registry, "ghost")).toBeNull();
    expect(clearOutcome(registry, "c1")).toBe(true);
    expect(statsOf(registry)).toEqual({ ledgers: 0, outcomes: 0, waiters: 0 });
  });

  test("abandons a running fork without touching the queue", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    const result = abandon(ledger, "f1", "parent cancelled");
    expect(result.ok).toBe(true);
    expect(result.fork.status).toBe(FAILED);
    expect(result.fork.reason).toBe("parent cancelled");
    expect(hasOpenChildren(ledger, "root")).toBe(false);
    expect(assertPairing(ledger).ok).toBe(true);
  });

  test("refuses to abandon a joined fork", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    markReady(ledger, "f1");
    takeReady(ledger, { ownerId: "root" });
    const result = abandon(ledger, "f1");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("FORK_ALREADY_JOINED");
  });
});
