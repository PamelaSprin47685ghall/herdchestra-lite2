import { describe, expect, test } from "bun:test";
import { serializeLedgerShared } from "../src/scope/forkjoin.mjs";
import { registerConsumer, commitConsumer, consumerPending } from "../src/scope/ledger-cache.mjs";

import {
  READY,
  JOINED,
  FAILED,
  RUNNING,
  abandon,
  applyCharge,
  applyRefund,
  assertPairing,
  createBracketLedger,
  enqueueScopeMessage,
  enqueueRootMessage,
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
  takePendingInbox,
} from "../src/scope/forkjoin.mjs";

function fork(ledger, forkId, ownerId = "root", depth = 0, levelKey = "L0") {
  const result = registerFork(ledger, {
    forkId,
    ownerId,
    levelKey,
    fsm: `task ${forkId}`,
    depth,
  });
  expect(result.ok).toBe(true);
  return result.fork;
}

describe("registration boundary", () => {
  test("a clock throwing after sequence allocation leaves the change marked", () => {
    const ledger = createBracketLedger();
    const consumer = {};
    registerConsumer(ledger, consumer);
    commitConsumer(ledger, consumer);
    const failure = new Error("clock failed");
    expect(() => registerFork(ledger, {
      forkId: "f1", ownerId: "root", fsm: "task", depth: 0,
    }, { clock: { start() { throw failure; } } })).toThrow(failure);
    expect(ledger.seq).toBe(1);
    expect(forkOf(ledger, "f1")).toBeNull();
    expect(consumerPending(ledger, consumer).struct).toBe(true);
  });
});

describe("mailbox delivery boundary", () => {
  test("root inbox initialization is marked before a message getter throws", () => {
    const ledger = createBracketLedger();
    delete ledger.rootInbox;
    const consumer = {};
    registerConsumer(ledger, consumer);
    commitConsumer(ledger, consumer);
    const failure = new Error("message getter failed");
    expect(() => enqueueRootMessage(ledger, {
      get from() { throw failure; },
    })).toThrow(failure);
    expect(ledger.rootInbox).toEqual([]);
    expect(consumerPending(ledger, consumer).struct).toBe(true);
  });

  test("inbox initialization is marked before a message getter throws", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, "f1");
    delete record.inbox;
    const before = serializeLedgerShared(ledger);
    const consumer = {};
    registerConsumer(ledger, consumer);
    commitConsumer(ledger, consumer);
    const failure = new Error("message getter failed");
    expect(() => enqueueScopeMessage(ledger, "f1", {
      get from() { throw failure; },
    })).toThrow(failure);
    expect(record.inbox).toEqual([]);
    expect(consumerPending(ledger, consumer).records).toContain("f1");
    expect(before.forks.f1.inbox).toBeUndefined();
    expect(serializeLedgerShared(ledger).forks.f1.inbox).toEqual([]);
  });

  test("a queued message is marked even if reading the optional budget throws", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    const before = serializeLedgerShared(ledger);
    const consumer = {};
    registerConsumer(ledger, consumer);
    commitConsumer(ledger, consumer);
    const failure = new Error("budget getter failed");
    const message = {
      message: "queued before failure",
      get budget() { throw failure; },
    };
    expect(() => enqueueScopeMessage(ledger, "f1", message)).toThrow(failure);
    expect(consumerPending(ledger, consumer).records).toContain("f1");
    const after = serializeLedgerShared(ledger);
    expect(before.forks.f1.inbox).toEqual([]);
    expect(after.forks.f1.inbox.map((entry) => entry.message)).toEqual(["queued before failure"]);
  });

  test("taking unread messages advances the persisted cursor once", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    enqueueScopeMessage(ledger, "f1", { from: "/", message: "one" });
    enqueueScopeMessage(ledger, "f1", { from: "/", message: "two" });
    const before = serializeLedgerShared(ledger);
    expect(before.forks.f1.inboxDelivered).toBe(0);
    expect(takePendingInbox(ledger, "f1").map((item) => item.message)).toEqual(["one", "two"]);
    expect(serializeLedgerShared(ledger).forks.f1.inboxDelivered).toBe(2);
    expect(takePendingInbox(ledger, "f1")).toEqual([]);
    expect(takePendingInbox(ledger, "missing")).toEqual([]);
  });
});

describe("registration", () => {
  test("a throwing outcome getter leaves the partial ready transition marked", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, "f1");
    serializeLedgerShared(ledger);
    const consumer = {};
    registerConsumer(ledger, consumer);
    commitConsumer(ledger, consumer);
    const failure = new Error("outcome getter failed");
    expect(() => markReady(ledger, "f1", {
      get ok() { throw failure; },
    })).toThrow(failure);
    expect(record.status).toBe(READY);
    expect(record.readySeq).toBe(1);
    const pending = consumerPending(ledger, consumer);
    expect(pending.records).toContain("f1");
    expect(pending.struct).toBe(true);
  });

  test("reentrant outcome getters cannot consume marks for later fields", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, "f1");
    const consumer = {};
    registerConsumer(ledger, consumer);
    commitConsumer(ledger, consumer);
    const failure = new Error("reason failed");
    expect(() => markReady(ledger, "f1", {
      get ok() {
        // Simulate a synchronous persistence pass from an external getter.
        commitConsumer(ledger, consumer);
        return false;
      },
      get reason() { throw failure; },
    })).toThrow(failure);
    expect(record.outcome).toBe(FAILED);
    expect(consumerPending(ledger, consumer).records).toContain("f1");
  });

  test("legacy accounting field initialization is persisted on early returns", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, "f1");
    record.charges = null;
    const before = serializeLedgerShared(ledger);
    expect(before.forks.f1.charges).toBeNull();
    expect(applyCharge(ledger, "f1", {}).code).toBe("INVALID_TOOL");
    expect(serializeLedgerShared(ledger).forks.f1.charges).toEqual({});

    // A separate ledger keeps this check independent of the prior snapshot.
    const second = createBracketLedger();
    const other = fork(second, "f2");
    other.charges = null;
    expect(serializeLedgerShared(second).forks.f2.charges).toBeNull();
    expect(applyRefund(second, "f2", "missing").refunded).toBe(0);
    expect(serializeLedgerShared(second).forks.f2.charges).toEqual({});
  });
  test("a refused budget grant still persists the message already queued", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, "f1");
    const before = serializeLedgerShared(ledger);
    expect(before.forks.f1.inbox).toEqual([]);

    const result = enqueueScopeMessage(ledger, "f1", {
      from: "/", message: "queued despite refusal", budget: { read: -1 },
    });
    expect(result.ok).toBe(false);
    expect(record.inbox.map((entry) => entry.message)).toEqual(["queued despite refusal"]);
    expect(serializeLedgerShared(ledger).forks.f1.inbox.map((entry) => entry.message))
      .toEqual(["queued despite refusal"]);
  });
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
      fsm: "again",
      depth: 0,
    });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("DUPLICATE_FORK");
  });

  test("refuses an empty fsm on a new scope", async () => {
    const { handleForkCall } = await import("../src/station/fork-controls.mjs");
    const item = {
      scopeId: "probe",
      fsm: "   ",
      profession: "You are a careful worker like Ada Lovelace.",
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
      id: "call-empty-fsm",
      arguments: { forks: [item] },
    });
    expect(result.isError).toBe(true);
    // A fork only creates, so a blank fsm is refused at validation instead of
    // being left for a handler that has nothing to amend.
    expect(result.details.code).toBe("INVALID_FSM");
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

  test("creating an empty owner queue invalidates an already captured snapshot", () => {
    const ledger = createBracketLedger();
    const before = serializeLedgerShared(ledger);
    expect(Object.hasOwn(before.queues, "other")).toBe(false);
    expect(takeReady(ledger, { ownerId: "other" }).code).toBe("NO_READY_CHILD");
    expect(serializeLedgerShared(ledger).queues.other).toEqual([]);
  });

  test("an admission callback that mutates then throws leaves the record marked", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, "f1");
    markReady(ledger, "f1");
    serializeLedgerShared(ledger);
    const consumer = {};
    registerConsumer(ledger, consumer);
    commitConsumer(ledger, consumer);
    const failure = new Error("admission failed");
    expect(() => takeReady(ledger, {
      ownerId: "root",
      admit(candidate) {
        candidate.budget.read = 7;
        throw failure;
      },
    })).toThrow(failure);
    expect(record.budget.read).toBe(7);
    expect(consumerPending(ledger, consumer).records).toContain("f1");
    expect(serializeLedgerShared(ledger).forks.f1.budget.read).toBe(7);
  });

  test("removing a stale queue entry invalidates the persisted snapshot even when no result is ready", () => {
    const ledger = createBracketLedger();
    fork(ledger, "f1");
    markReady(ledger, "f1");
    // A stale entry is a documented input to takeReady, e.g. after reparenting.
    ledger.queues.root.unshift("missing");
    const before = serializeLedgerShared(ledger);
    expect(before.queues.root).toEqual(["missing", "f1"]);
    const taken = takeReady(ledger, { ownerId: "root", admit: () => ({ ok: false }) });
    expect(taken.code).toBe("NO_ADMISSIBLE_CHILD");
    expect(ledger.queues.root).toEqual(["f1"]);
    expect(serializeLedgerShared(ledger).queues.root).toEqual(["f1"]);
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
            fsm: "probe the cache",
            profession: "You are a cache engineer like Barbara Liskov.",
            budget: { read: 2 },
            time: 60,
            targets: ["src/cache.mjs"],
          },
        ],
      },
    });
    expect(forkOut.isError).toBeUndefined?.();
    // The receipt names the address, not just the last segment of it.
    expect(forkOut.content[0].text).toContain("/cache-probe: probe the cache");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].childDepth).toBe(1);
    expect(spawned[0].receipt).toContain("You are now in the scope /cache-probe");

    const early = handleJoinCall(station, {
      id: "call-j1",
      arguments: {},
    });
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toContain("No forked scope has returned yet");

    const { RETURN_OATH_KEY, RETURN_OATH_VALUE } = await import("../src/station/domain/handoff.mjs");
    const child = {
      state: { scopes: [], autopilot: false, relay: { generation: 0 } },
      forkLedgerPort: () => ledger,
      forkIdentityPort: () => ({ forkId: "call-f1", parentOwnerId: "root" }),
    };
    const returned = handleReturnCall(child, {
      id: "call-r1",
      arguments: {
        dafny: "the child returns its record",
        [RETURN_OATH_KEY]: RETURN_OATH_VALUE,
      },
    });
    expect(returned.isError).toBeUndefined();
    // The station seals the record and answers in the same beat.
    expect(returned.content[0].text).toContain("has been handed to Root");
    expect(returned.details.accepted).toBe(true);

    const joined = handleJoinCall(station, {
      id: "call-j2",
      arguments: {},
    });
    expect(joined.isError).toBeUndefined();
    expect(joined.content[0].text).toContain("[Record from forked scope — fork cache-probe]");
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
            scopeId: "probe", fsm: "x",
            profession: "You are a parser auditor like Michael Feathers.",
            budget: { read: 1 },
            time: 30,
            targets: ["src/parser.mjs"],
          },
        ],
      },
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("No scope spawner is attached");
  });

  test("rejects a malformed fork before any state change", async () => {
    const { validateFork } = await import("../src/station/domain/fork-join.mjs");
    const state = { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } };
    const base = {
      scopeId: "probe", fsm: "x",
      profession: "You are a parser auditor like Michael Feathers.",
      budget: { read: 1 },
      time: 30,
      targets: ["src/parser.mjs"],
    };
    expect(validateFork(base).ok).toBe(true);
    // Every fork creates a scope, so a blank fsm can no longer be deferred to
    // the handler: there is no existing record to fall back to.
    expect(validateFork({ ...base, fsm: "  " })).toMatchObject({
      ok: false,
      code: "INVALID_FSM",
    });
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
      fsm: "fix defects",
      profession: "You are a defect fixer like Michael Feathers.",
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
    const { RETURN_OATH_KEY, RETURN_OATH_VALUE } = await import("../src/station/domain/handoff.mjs");
    const returned = handleReturnCall(child, {
      id: "call-rp",
      arguments: {
        dafny: "the child hands its own children to the parent first",
        [RETURN_OATH_KEY]: RETURN_OATH_VALUE,
      },
    });
    expect(returned.content[0].text).toContain("has been handed to Root");
    expect(returned.content[0].text).toContain("scope-2");
    // A return is answered in the same beat; nothing is parked on a join.
    expect(returned.details.accepted).toBe(true);
    const taken = handleJoinCall(station, {
      id: "call-jp",
      arguments: {},
    });
    expect(taken.details.joined).toBe(true);
    expect(taken.content[0].text).toContain("[Record from forked scope — fork scope-1]");
    expect(taken.content[0].text).toContain("Unreceived: 1 (scope-2).");
    expect(taken.content[0].text).toContain("Call scope_join again to take the next one.");
  });

  test("appends the dafny to the end of the child's record", async () => {
    const { handleReturnCall, handleJoinCall } = await import(
      "../src/station/fork-controls.mjs"
    );
    const ledger = createBracketLedger();
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "found the leak" }] },
    ];
    const child = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
      forkLedgerPort: () => ledger,
      forkIdentityPort: () => ({
        forkId: "call-p",
        parentOwnerId: "root",
        ownScopeId: "call-p",
      }),
      contextMessages: () => messages,
      setChildOutcome: () => {},
    };
    fork(ledger, "call-p", "root", 0);
    const { RETURN_OATH_KEY, RETURN_OATH_VALUE } = await import("../src/station/domain/handoff.mjs");
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    const returned = handleReturnCall(child, {
      id: "call-rp",
      arguments: { dafny: table, [RETURN_OATH_KEY]: RETURN_OATH_VALUE },
    });
    expect(returned.details.accepted).toBe(true);
    const station = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
      forkLedgerPort: () => ledger,
    };
    const taken = handleJoinCall(station, { id: "call-jp", arguments: {} });
    const text = taken.content[0].text;
    expect(taken.details.joined).toBe(true);
    expect(text).toContain("found the leak");
    expect(text).toContain(table);
    expect(text.indexOf(table)).toBeGreaterThan(text.indexOf("found the leak"));
  });

  test("refuses root scope_return without dafny or without rewind capability", async () => {
    const { handleReturnCall } = await import("../src/station/fork-controls.mjs");
    const station = {
      state: { scopes: [], autopilot: false, relay: { generation: 0, bigStreak: 0, canStop: false, userPrompts: [], pendingRewind: null } },
      forkLedgerPort: () => createBracketLedger(),
    };
    const missing = handleReturnCall(station, {
      id: "call-x",
      arguments: {},
    });
    expect(missing.isError).toBe(true);
    expect(missing.details.code).toBe("MISSING_DAFNY");

    const unavailable = handleReturnCall(station, {
      id: "call-y",
      arguments: { dafny: "root report without manager" },
    });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.details.code).toBe("ROOT_REWIND_UNAVAILABLE");
  });

  test("parks a join until a child returns, then takes it", async () => {
    const { createForkRegistry, ledgerFor, notifyWaiters, waitForReady } = await import(
      "../src/scope/fork-registry.mjs"
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
      "../src/scope/fork-registry.mjs"
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
      "../src/scope/fork-registry.mjs"
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
    const { notifyWaiters } = await import("../src/scope/fork-registry.mjs");
    notifyWaiters(registry);
    const out = await pending;
    expect(out.ok).toBe(true);
    expect(out.fork.status).toBe(JOINED);
  });

  test("stores and reads a child record by fork id", async () => {
    const { createForkRegistry, clearOutcome, outcomeOf, setOutcome, statsOf } = await import(
      "../src/scope/fork-registry.mjs"
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
