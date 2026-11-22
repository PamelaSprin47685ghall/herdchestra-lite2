import { describe, expect, test } from "bun:test";

import {
  BLOCKED,
  JOINED,
  READY,
  RUNNING,
  blockedChildren,
  createBracketLedger,
  forkOf,
  markReady,
  openChildren,
  registerFork,
  statsOf,
  takeReady,
} from "../src/scope/forkjoin.mjs";
import { handleForkCall, handleJoinCall } from "../src/station/fork-controls.mjs";

const STATE = () => ({
  scopes: [],
  autopilot: false,
  relay: { generation: 0, fullFlow: false },
});

function item(intent, blocked = false) {
  return {
    scopeId: intent.replaceAll(" ", "-"),
    intent,
    blocked,
    budget: { read: 1 },
    time: 30,
    targets: ["src/blocked.mjs"],
  };
}

function stationWith(ledger, spawned = null) {
  const station = {
    state: STATE(),
    forkLedgerPort: () => ledger,
  };
  if (spawned) {
    station.childSpawnPort = () => (spec) => {
      spawned.push(spec);
    };
  }
  return station;
}

describe("blocked entries in the ledger", () => {
  test("a blocked fork is recorded without being open or joinable", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, {
      forkId: "b1",
      ownerId: "root",
      levelKey: "L",
      intent: "later",
      depth: 0,
      blocked: true,
    });
    expect(forkOf(ledger, "b1").status).toBe(BLOCKED);
    expect(openChildren(ledger, "root")).toEqual([]);
    expect(blockedChildren(ledger, "root")).toEqual(["b1"]);
    const taken = takeReady(ledger, { ownerId: "root", levelKey: "L" });
    expect(taken.ok).toBe(false);
    expect(taken.code).toBe("NO_READY_CHILD");
    expect(statsOf(ledger)).toEqual({
      forks: 1,
      running: 0,
      ready: 0,
      joined: 0,
      failed: 0,
      blocked: 1,
      levels: 0,
    });
  });

  test("a blocked entry cannot be marked ready", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, {
      forkId: "b1",
      ownerId: "root",
      levelKey: "L",
      intent: "later",
      depth: 0,
      blocked: true,
    });
    const marked = markReady(ledger, "b1");
    expect(marked.ok).toBe(false);
    expect(marked.code).toBe("FORK_NOT_RUNNING");
  });

  test("running and blocked entries stay separable", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "r1", ownerId: "root", levelKey: "L", intent: "a", depth: 0 });
    registerFork(ledger, {
      forkId: "b1",
      ownerId: "root",
      levelKey: "L",
      intent: "b",
      depth: 0,
      blocked: true,
    });
    expect(openChildren(ledger, "root")).toEqual(["r1"]);
    expect(blockedChildren(ledger, "root")).toEqual(["b1"]);
    expect(forkOf(ledger, "r1").status).toBe(RUNNING);
  });
});

describe("batch fork with a checkpoint", () => {
  test("starts the unblocked items and only records the blocked ones", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationWith(ledger, spawned);
    const out = handleForkCall(station, {
      id: "call-batch",
      arguments: {
        forks: [item("write the module"), item("wire it into the host", true), item("measure")],
      },
    });
    expect(out.isError).toBeUndefined();
    expect(spawned).toHaveLength(2);
    expect(spawned.map((entry) => entry.forkId)).toEqual(["call-batch:0", "call-batch:2"]);
    const text = out.content[0].text;
    expect(text).toContain("Started (2)");
    expect(text).toContain("Deferred, not started (1):\n- wire-it-into-the-host");
    expect(blockedChildren(ledger, "root")).toEqual(["call-batch:1"]);
    expect(openChildren(ledger, "root")).toEqual(["call-batch:0", "call-batch:2"]);
  });

  test("a pure checkpoint needs no spawner", () => {
    const ledger = createBracketLedger();
    const station = stationWith(ledger, null);
    const out = handleForkCall(station, {
      id: "call-plan",
      arguments: { forks: [item("one", true), item("two", true)] },
    });
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("Resubmit deferred items when ready.");
    expect(blockedChildren(ledger, "root")).toEqual(["call-plan:0", "call-plan:1"]);
    expect(openChildren(ledger, "root")).toEqual([]);
  });

  test("a batch with any startable item still requires a spawner", () => {
    const ledger = createBracketLedger();
    const station = stationWith(ledger, null);
    const out = handleForkCall(station, {
      id: "call-mix",
      arguments: { forks: [item("run"), item("later", true)] },
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("No child spawner is attached");
  });

  test("one malformed item rejects the whole batch", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationWith(ledger, spawned);
    const bad = { ...item("good"), ...{} };
    const out = handleForkCall(station, {
      id: "call-bad",
      arguments: { forks: [bad, { ...item("bad", false), budget: { read: -1 } }] },
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("forks[1]");
    expect(spawned).toHaveLength(0);
    expect(statsOf(ledger).forks).toBe(0);
  });

  test("blocked entries do not keep the parent from joining", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationWith(ledger, spawned);
    handleForkCall(station, {
      id: "call-pair",
      arguments: { forks: [item("run"), item("later", true)] },
    });
    markReady(ledger, "call-pair:0");
    const joined = handleJoinCall(station, { id: "call-j" });
    expect(joined.isError).toBeUndefined();
    expect(joined.content[0].text).toContain("[Child record — fork run]");
    expect(joined.content[0].text).toContain("Unreceived: 0.");
    expect(forkOf(ledger, "call-pair:0").status).toBe(JOINED);
    expect(forkOf(ledger, "call-pair:1").status).toBe(BLOCKED);
  });

  test("invalid or duplicate scope names never start any member of the batch", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationWith(ledger, spawned);
    for (const [suffix, scopeId, code] of [
      ["invalid", "provider|id", "INVALID_SCOPE_ID"],
      ["root", "Root", "INVALID_SCOPE_ID"],
    ]) {
      const result = handleForkCall(station, {
        id: `internal-${suffix}`,
        arguments: { forks: [item("first"), { ...item("second"), scopeId }] },
      });
      expect(result.details.code).toBe(code);
      expect(result.content[0].text).not.toContain(`internal-${suffix}`);
    }
    expect(spawned).toEqual([]);
    expect(ledger.order).toEqual([]);
  });

  test("an empty fork array is refused", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationWith(ledger, spawned);
    const out = handleForkCall(station, { id: "call-empty", arguments: { forks: [] } });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("Invalid fork arguments");
  });

  test("a single-item batch keeps the plain fork id", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationWith(ledger, spawned);
    handleForkCall(station, {
      id: "call-one",
      arguments: { forks: [item("solo")] },
    });
    expect(spawned[0].forkId).toBe("call-one");
    expect(forkOf(ledger, "call-one").status).toBe(RUNNING);
  });

  test("a blocked flag that is not a boolean is refused", () => {
    const ledger = createBracketLedger();
    const spawned = [];
    const station = stationWith(ledger, spawned);
    const out = handleForkCall(station, {
      id: "call-flag",
      arguments: { forks: [{ ...item("x"), blocked: "yes" }] },
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("forks[0]");
    expect(spawned).toHaveLength(0);
  });

  test("a returning checkpoint leaves the deferred entry untouched", () => {
    const ledger = createBracketLedger();
    registerFork(ledger, { forkId: "b1", ownerId: "root", levelKey: "L", intent: "later", depth: 0, blocked: true });
    markReady(ledger, "b1");
    expect(forkOf(ledger, "b1").status).toBe(BLOCKED);
    expect(blockedChildren(ledger, "root")).toEqual(["b1"]);
  });
});
