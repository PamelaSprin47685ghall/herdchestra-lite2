// The receive obligation is "running OR ready", and a join's summary binds to
// one receipt.
//
// Three consumer-visible failures are pinned here:
// 1. a returned result no join has taken must still block a stop and appear in
//    the next receipt, exactly like a running child;
// 2. a whitespace-only elder_report must be refused, because it passes the gate
//    while the receipt writer stores nothing;
// 3. a join that waited must file its summary against the receipt the model
//    read, or refuse without taking a child.

import { describe, expect, test } from "bun:test";

import { createState } from "../src/scope/state.mjs";
import {
  createBracketLedger,
  forkOf,
  markReady,
  registerFork,
  unreceivedChildren,
} from "../src/scope/forkjoin.mjs";
import { createProcessedLedger } from "../src/station/processed-ledger.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { handleJoinCall } from "../src/station/fork-controls.mjs";
import { nudgeDecision } from "../src/station/nudge.mjs";
import { onSessionStop } from "../src/station/gates.mjs";
import { notifyWaiters } from "../src/host/fork-registry.mjs";
import { joinTicket } from "../src/tools/tickets.mjs";

function forkChild(ledger, forkId, ownerId = "root") {
  const out = registerFork(ledger, {
    forkId,
    ownerId,
    levelKey: "root|0|0",
    intent: `task ${forkId}`,
    depth: 0,
  });
  expect(out.ok).toBe(true);
  return out.fork;
}

/** A station with the real station methods and only host edges stubbed. */
function stationFor(registry, ledger) {
  const station = Object.create(SessionStation.prototype);
  station.state = createState();
  station.processed = createProcessedLedger();
  station.ownerId = null;
  station.forkLedgerPort = () => ledger;
  station.forkWaitPort = () => ({ registry, ledger });
  station.forkIdentityPort = () => null;
  station.childOutcomePort = () => null;
  station.assistantForToolCall = () => null;
  station.messageForToolCall = () => null;
  station.processAssistantMessage = () => {};
  station.persist = () => {};
  return station;
}

function registryOf() {
  return { waiters: new Set(), outcomes: new Map() };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("a returned child is unreceived work", () => {
  test("ready and running children both count; joined and blocked do not", () => {
    const ledger = createBracketLedger();
    forkChild(ledger, "running");
    forkChild(ledger, "ready");
    forkChild(ledger, "joined");
    forkChild(ledger, "plan");
    markReady(ledger, "ready");
    markReady(ledger, "joined");
    ledger.forks.joined.status = "joined";
    ledger.forks.plan.status = "blocked";

    expect(unreceivedChildren(ledger, "root")).toEqual(["running", "ready"]);
  });

  test("a stop with only a ready child steers instead of finishing", () => {
    const ledger = createBracketLedger();
    forkChild(ledger, "ready");
    markReady(ledger, "ready");
    const station = {
      state: createState(),
      forkLedgerPort: () => ledger,
      forkOwnerId: () => null,
      relayOn: () => true,
      recordNaturalStop: () => {
        throw new Error("a ready child must not be retired silently");
      },
    };
    const out = onSessionStop(station, {});
    expect(out?.continue).toBe(true);
    expect(out.additionalContext).toContain("1 unreceived child result");
  });

  test("a no-tool-call message is nudged while a ready child waits", () => {
    const ledger = createBracketLedger();
    forkChild(ledger, "ready");
    markReady(ledger, "ready");
    const decision = nudgeDecision(createState(), {
      hasToolCalls: false,
      ledger,
      ownerId: "root",
    });
    expect(decision.kind).toBe("steer");
    expect(decision.text).toContain("1 unreceived child result");
  });

  test("a ready child appears in the join receipt and keeps the report gate", () => {
    const ledger = createBracketLedger();
    forkChild(ledger, "a");
    forkChild(ledger, "b");
    markReady(ledger, "a");
    markReady(ledger, "b");
    const station = stationFor(registryOf(), ledger);

    const first = handleJoinCall(station, { id: "j1", arguments: { elder_report: null } });
    expect(first.details.joined).toBe(true);
    expect(first.content[0].text).toContain("Unreceived: 1 (scope-2).");
    expect(first.content[0].text).toContain("elder_report for receipt scope-1");

    const second = handleJoinCall(station, {
      id: "j2",
      arguments: { elder_report: "a found the parser path and left the lexer open" },
    });
    expect(second.details.joined).toBe(true);
    expect(second.content[0].text).toContain("Unreceived: 0.");
    expect(second.content[0].text).not.toContain("elder_report");
    expect(station.state.receipts[0].report).toBe(
      "a found the parser path and left the lexer open",
    );
  });
});

describe("the elder binding is exact", () => {
  test("a whitespace-only summary is refused before any take", () => {
    const ledger = createBracketLedger();
    forkChild(ledger, "c1");
    markReady(ledger, "c1");
    const station = stationFor(registryOf(), ledger);

    const out = handleJoinCall(station, { id: "j1", arguments: { elder_report: "   " } });
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("INVALID_ARGUMENT");
    expect(forkOf(ledger, "c1").status).toBe("ready");
  });

  test("a reported youngest receipt is not demanded again", () => {
    const ledger = createBracketLedger();
    forkChild(ledger, "c1");
    markReady(ledger, "c1");
    const station = stationFor(registryOf(), ledger);
    station.state.receipts = [
      {
        forkToolCallId: "f0",
        closeToolCallId: "j0",
        levelKey: "root|0|0",
        closedOrder: 1,
        report: "already filed",
        collapsed: false,
      },
    ];

    const out = handleJoinCall(station, { id: "j1", arguments: { elder_report: null } });
    expect(out.details.joined).toBe(true);
  });

  test("two waiting joins cannot both file a summary for the same receipt", async () => {
    const ledger = createBracketLedger();
    const registry = registryOf();
    const station = stationFor(registry, ledger);
    forkChild(ledger, "c1");
    forkChild(ledger, "c2");
    markReady(ledger, "c1");

    // The first join takes c1 and files receipt j1.
    const first = await joinTicket(station, "j1", { elder_report: null }, {});
    expect(first.details.joined).toBe(true);
    expect(station.state.receipts).toHaveLength(1);

    // Two joins carry the same summary for j1 and wait for c2.
    const summary = "c1 found the parser path and left the lexer open";
    const left = joinTicket(station, "j2", { elder_report: summary }, {});
    const right = joinTicket(station, "j3", { elder_report: summary }, {});
    await tick();
    markReady(ledger, "c2");
    notifyWaiters(registry);

    const settled = await Promise.all([left, right]);
    const winners = settled.filter((entry) => entry.details?.joined === true);
    const stale = settled.filter((entry) => entry.details?.code === "STALE_ELDER_REPORT");
    expect(winners).toHaveLength(1);
    expect(stale).toHaveLength(1);
    // The summary landed on the receipt the model named, and the loser took
    // nothing: c2 has exactly one receiver.
    expect(station.state.receipts[0].report).toBe(
      "c1 found the parser path and left the lexer open",
    );
    expect(station.state.receipts).toHaveLength(2);
    expect(forkOf(ledger, "c2").status).toBe("joined");
    expect(stale[0].content[0].text).toContain("took no result");
  });

  test("a join with no work says the summary was not committed", async () => {
    const ledger = createBracketLedger();
    const registry = registryOf();
    const station = stationFor(registry, ledger);
    station.state.receipts = [
      {
        forkToolCallId: "f0",
        closeToolCallId: "j0",
        levelKey: "root|0|0",
        closedOrder: 1,
        report: null,
        collapsed: false,
      },
    ];

    const out = await joinTicket(station, "j1", { elder_report: "belongs to j0" }, {});
    expect(out.isError).toBe(true);
    expect(out.details.code).toBe("NO_UNRECEIVED_WORK");
    expect(out.content[0].text).toContain("was not committed");
    expect(station.state.receipts[0].report).toBeNull();
  });

  test("no work answers before it demands a summary", () => {
    const ledger = createBracketLedger();
    const station = stationFor(registryOf(), ledger);
    station.state.receipts = [
      {
        forkToolCallId: "f0",
        closeToolCallId: "j0",
        levelKey: "root|0|0",
        closedOrder: 1,
        report: null,
        collapsed: false,
      },
    ];

    // The receipt has no summary yet, but no join can file one now. Demanding
    // it would only send the model in a circle.
    const out = handleJoinCall(station, { id: "j1", arguments: { elder_report: null } });
    expect(out.details.code).toBe("NO_READY_CHILD");
    expect(out.details.active).toBe(0);
  });
});
