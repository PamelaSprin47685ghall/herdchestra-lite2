// Contract edges that the blueprint names explicitly and the happy-path tests
// do not reach: adoption follows the current receiver and a lost bracket never
// parks its child forever.

import { describe, expect, test } from "bun:test";

import {
  BLOCKED,
  createBracketLedger,
  forkOf,
  markReady,
  openChildren,
  readyChildren,
  registerFork,
  reparentOrphans,
} from "../src/scope/forkjoin.mjs";
import {
  handleForkCall,
  handleJoinCall,
  handleReturnCall,
} from "../src/station/fork-controls.mjs";
import {
  createForkRegistry,
  ledgerFor,
  notifyWaiters,
  waitForJoin,
} from "../src/scope/fork-registry.mjs";

function state() {
  return { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } };
}

function stationFor(ledger, identity = null) {
  return {
    state: state(),
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => identity,
  };
}

describe("adoption follows the current receiver", () => {
  test("a reparented branch hands its children to its current parent", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "p", ownerId: "root", knuth_nfa_inspired_fsm: "parent", depth: 0 });
    registerFork(ledger, { forkId: "c", ownerId: "p", knuth_nfa_inspired_fsm: "child", depth: 1 });
    // p itself was adopted by g before it returns.
    // The grandparent adopts p, and p still owns c.
    reparentOrphans(ledger, "root", "g");
    expect(forkOf(ledger, "p").ownerId).toBe("g");

    const out = handleReturnCall(
      stationFor(ledger, { forkId: "p", parentOwnerId: "root" }),
      { id: "r", arguments: {} },
    );
    expect(out.isError).toBeUndefined();
    expect(out.details.receiver).toBe("g");
    expect(forkOf(ledger, "c").ownerId).toBe("g");
    expect(out.content[0].text).toContain("queued for scope");
  });

  test("blocked entries move with the plan they belong to", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, {
      forkId: "later",
      ownerId: "p",
      knuth_nfa_inspired_fsm: "needs a decision",
      depth: 1,
      blocked: true,
    });
    const moved = reparentOrphans(ledger, "p", "g");
    expect(moved).toEqual({ ok: true, moved: 1, transferred: 0 });
    expect(forkOf(ledger, "later").ownerId).toBe("g");
    expect(forkOf(ledger, "later").status).toBe(BLOCKED);
    expect(openChildren(ledger, "g")).toEqual([]);
  });
});

describe("a lost bracket never parks its child", () => {
  test("waitForJoin returns when the bracket was abandoned", async () => {
    const registry = createForkRegistry();
    const ledger = ledgerFor(registry, "lost");
    registerFork(ledger, { forkId: "c", ownerId: "root", knuth_nfa_inspired_fsm: "child", depth: 0 });
    markReady(ledger, "c");
    forkOf(ledger, "c").status = "failed";
    const waited = await waitForJoin(registry, ledger, "c");
    expect(waited.ok).toBe(false);
    expect(waited.code).toBe("RETURN_REJECTED");
  });
});

describe("an idle join answers instead of waiting", () => {
  test("no running and no ready child refuses", () => {
    const ledger = createBracketLedger();
    const out = handleJoinCall(stationFor(ledger), {
      id: "j",
      arguments: {},
    });
    expect(out.isError).toBe(true);
    expect(out.details.active).toBe(0);
  });
});

describe("a batch projects one item into each child", () => {
  test("each child's start receipt names only its own fork", () => {
    const ledger = createBracketLedger();
    const specs = [];
    const station = stationFor(ledger);
    station.childSpawnPort = () => (spec) => specs.push(spec);
    const out = handleForkCall(station, {
      id: "fb",
      arguments: {
        forks: [
          { scopeId: "one", knuth_nfa_inspired_fsm: "one", budget: { read: 1 }, time: 60, targets: ["one.mjs"], blocked: false },
          { scopeId: "two", knuth_nfa_inspired_fsm: "two", budget: { read: 1 }, time: 60, targets: ["two.mjs"], blocked: false },
        ],
      },
    });
    expect(out.isError).toBeUndefined();
    expect(specs.map((spec) => spec.forkId)).toEqual(["fb:0", "fb:1"]);
    expect(specs[0].receipt).toContain("You are the child of fork one");
    expect(specs[0].receipt).toContain("FSM: one");
    expect(specs[0].receipt).toContain("User messages go to the stable root");
    expect(specs[0].receipt).toContain("Only scope_return submits your full record");
    expect(specs[0].receipt).not.toContain("FSM: two");
    expect(specs[1].receipt).toContain("You are the child of fork two");
    expect(specs[1].receipt).toContain("FSM: two");
    expect(specs[1].receipt).not.toContain("FSM: one");
  });
});

describe("repeated right brackets do not double-count", () => {
  test("a second scope_return is refused and moves no bracket", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "p", ownerId: "root", knuth_nfa_inspired_fsm: "parent", depth: 0 });
    registerFork(ledger, { forkId: "c", ownerId: "p", knuth_nfa_inspired_fsm: "child", depth: 1 });
    const station = stationFor(ledger, { forkId: "p", parentOwnerId: "root" });
    const first = handleReturnCall(station, { id: "r1", arguments: {} });
    expect(first.isError).toBeUndefined();
    expect(forkOf(ledger, "p").status).toBe("ready");
    const second = handleReturnCall(station, { id: "r2", arguments: {} });
    expect(second.isError).toBe(true);
    expect(second.details.code).toBe("FORK_NOT_RUNNING");
    // The still-running child was not handed over twice.
    expect(openChildren(ledger, "root")).toEqual(["c"]);
    expect(readyChildren(ledger, "root")).toEqual(["p"]);
  });

  test("a second join finds nothing to take", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "f1", ownerId: "root", knuth_nfa_inspired_fsm: "child", depth: 0 });
    markReady(ledger, "f1");
    const station = stationFor(ledger);
    const first = handleJoinCall(station, { id: "j1", arguments: {} });
    expect(first.isError).toBeUndefined();
    const second = handleJoinCall(station, { id: "j2", arguments: {} });
    expect(second.isError).toBe(true);
    expect(second.details.code).toBe("NO_READY_CHILD");
  });
});

describe("a join leaves the parent where it was", () => {
  test("receives a child without moving the parent's level, model or budget", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "f1", ownerId: "root", knuth_nfa_inspired_fsm: "child", depth: 0 });
    markReady(ledger, "f1");
    const station = stationFor(ledger);
    station.state = {
      scopes: [
        {
          id: "s1",
          knuth_nfa_inspired_fsm: "parent work",
          budget: { read: 3, bash: 1 },
          remaining: { read: 2, bash: 1 },
          modelKey: "parent-model",
        },
      ],
      modelCaches: { "parent-model": { cachedUntilPos: 5, chars: 900 } },
      autopilot: false,
      relay: { generation: 0, fullFlow: false, canStop: false },
      pins: [],
      receipts: [],
    };
    const before = structuredClone(station.state);
    const out = handleJoinCall(station, { id: "j1" });
    expect(out.isError).toBeUndefined();
    expect(out.details.forkId).toBe("f1");
    expect(out.details.joined).toBe(true);
    // The child merged into the parent: the parent's level, its model key,
    // its cache ledger and its remaining budget are byte-identical. Only the
    // receipt chain may grow, and this station has no receipt writer.
    expect(station.state).toEqual(before);
    expect(ledger.order).toContain("f1");
  });
});
