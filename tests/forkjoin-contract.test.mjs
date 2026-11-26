// Contract edges that the blueprint names explicitly and the happy-path tests
// do not reach: adoption follows the current receiver and a lost bracket never
// parks its child forever.

import { describe, expect, test } from "bun:test";

import {
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
import { RETURN_OATH_KEY, RETURN_OATH_VALUE } from "../src/station/domain/handoff.mjs";

const OATH = { [RETURN_OATH_KEY]: RETURN_OATH_VALUE };

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
    registerFork(ledger, { forkId: "p", ownerId: "root", fsm: "parent", depth: 0 });
    registerFork(ledger, { forkId: "c", ownerId: "p", fsm: "child", depth: 1 });
    // p itself was adopted by g before it returns.
    // The grandparent adopts p, and p still owns c.
    reparentOrphans(ledger, "root", "g");
    expect(forkOf(ledger, "p").ownerId).toBe("g");

    const out = handleReturnCall(
      stationFor(ledger, { forkId: "p", parentOwnerId: "root" }),
      { id: "r", arguments: { dafny: "p returns through the station handler", ...OATH } },
    );
    expect(out.isError).toBeUndefined();
    expect(out.details.receiver).toBe("g");
    expect(forkOf(ledger, "c").ownerId).toBe("g");
    expect(out.content[0].text).toContain("delivered to");
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
          { scopeId: "one", fsm: "one", profession: "You are the first worker like Ada Lovelace.", budget: { read: 1 }, time: 60, targets: ["one.mjs"] },
          { scopeId: "two", fsm: "two", profession: "You are the second worker like Grace Hopper.", budget: { read: 1 }, time: 60, targets: ["two.mjs"] },
        ],
      },
    });
    expect(out.isError).toBeUndefined();
    expect(specs.map((spec) => spec.forkId)).toEqual(["fb:0", "fb:1"]);
    expect(specs[0].receipt).toContain("You are now in the scope /one");
    expect(specs[0].receipt).toContain("State machine: one");
    expect(specs[0].receipt).toContain("User messages go to the stable root");
    expect(specs[0].receipt).toContain("Use the `scope_return` oath to submit your record");
    expect(specs[0].receipt).not.toContain("State machine: two");
    expect(specs[1].receipt).toContain("You are now in the scope /two");
    expect(specs[1].receipt).toContain("State machine: two");
    expect(specs[1].receipt).not.toContain("State machine: one");
  });
});

describe("a return without a closing text is refused", () => {
  test("a missing dafny is refused before any bracket moves", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "p", ownerId: "root", fsm: "parent", depth: 0 });
    const station = stationFor(ledger, { forkId: "p", parentOwnerId: "root" });
    const out = handleReturnCall(station, { id: "r1", arguments: {} });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("MISSING_DAFNY");
    // Nothing moved: the caller can retry with the field filled in.
    expect(forkOf(ledger, "p").status).toBe("running");
    expect(readyChildren(ledger, "root")).toEqual([]);
  });

  test("whitespace alone does not satisfy the field", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "p", ownerId: "root", fsm: "parent", depth: 0 });
    const station = stationFor(ledger, { forkId: "p", parentOwnerId: "root" });
    const out = handleReturnCall(station, { id: "r1", arguments: { dafny: " \n\t " } });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("MISSING_DAFNY");
    expect(forkOf(ledger, "p").status).toBe("running");
  });
});

describe("repeated right brackets do not double-count", () => {
  test("a second scope_return is refused and moves no bracket", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "p", ownerId: "root", fsm: "parent", depth: 0 });
    registerFork(ledger, { forkId: "c", ownerId: "p", fsm: "child", depth: 1 });
    const station = stationFor(ledger, { forkId: "p", parentOwnerId: "root" });
    const first = handleReturnCall(station, { id: "r1", arguments: { dafny: "first return makes the bracket ready", ...OATH } });
    expect(first.isError).toBeUndefined();
    expect(forkOf(ledger, "p").status).toBe("ready");
    const second = handleReturnCall(station, { id: "r2", arguments: { dafny: "second return: the bracket already moved", ...OATH } });
    expect(second.isError).toBe(true);
    expect(second.details.code).toBe("FORK_NOT_RUNNING");
    // The still-running child was not handed over twice.
    expect(openChildren(ledger, "root")).toEqual(["c"]);
    expect(readyChildren(ledger, "root")).toEqual(["p"]);
  });

  test("a second join finds nothing to take", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "f1", ownerId: "root", fsm: "child", depth: 0 });
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
  test("receives a child without moving the parent's level, model or turns", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "f1", ownerId: "root", fsm: "child", depth: 0 });
    markReady(ledger, "f1");
    const station = stationFor(ledger);
    station.state = {
      scopes: [
        {
          id: "s1",
          fsm: "parent work",
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
    // its cache ledger and its remaining turns are byte-identical. Only the
    // receipt chain may grow, and this station has no receipt writer.
    expect(station.state).toEqual(before);
    expect(ledger.order).toContain("f1");
  });
});
