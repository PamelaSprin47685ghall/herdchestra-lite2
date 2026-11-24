// The two right brackets must block, and the block belongs to the ticket.
//
// A station is synchronous by contract, so these tests drive the real
// execute/ticket pair over a minimal station surface: the same code path the
// host calls, with the host replaced by plain data.

import { describe, expect, test } from "bun:test";

import { executeJoin, executeReturn } from "../src/station/execute.mjs";
import { renderJoinResult } from "../src/station/fork-controls.mjs";
import { createProcessedLedger } from "../src/station/processed-ledger.mjs";
import { joinTicket, returnTicket } from "../src/tools/tickets.mjs";
import { createForkWiring } from "../src/scope/fork-wiring.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { bindStationPorts } from "./helpers/station-ports.mjs";
import { attachForkPorts } from "./helpers/fork-attach.mjs";
import {
  registerFork,
  takeReady,
} from "../src/scope/forkjoin.mjs";
import { notifyWaiters, pulse } from "../src/scope/fork-registry.mjs";

function stateOf() {
  return {
    scopes: [],
    autopilot: false,
    epoch: 0,
    relay: { generation: 0, fullFlow: false },
  };
}

function stationOf(registry, ledger, identity = null) {
  const station = {
    state: stateOf(),
    processed: createProcessedLedger(),
    ownerId: null,
    forkIdentityPort: () => identity,
    forkLedgerPort: () => ledger,
    forkWaitPort: () => ({ registry, ledger }),
    childOutcomePort: (forkId) => registry.outcomes.get(forkId) ?? null,
    assistantForToolCall: () => null,
    messageForToolCall: () => null,
    persist: () => {},
  };
  // The fixture is not a SessionStation instance, but it honours the same
  // station contract: the production binder supplies the fork ports once.
  station.bindForkPorts = SessionStation.prototype.bindForkPorts;
  station.ports = bindStationPorts(station.state);
  station.executeJoin = (toolCallId, params, ctx) =>
    executeJoin(station, toolCallId, params, ctx);
  station.executeReturn = (toolCallId, params, ctx) =>
    executeReturn(station, toolCallId, params, ctx);
  // The class method does this; the fixture must match the surface the
  // ticket calls after waitForReady has already taken the child.
  station.finalizeJoin = (toolCallId, record) => {
    const result = renderJoinResult(station, record);
    station.processed.setHandled(toolCallId, result);
    station.processed.markCall(toolCallId);
    return result;
  };
  return station;
}

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 };
}

function opened(ledger, forkId, ownerId = "root") {
  const result = registerFork(ledger, {
    forkId,
    ownerId,
    levelKey: "root|0|0",
    fsm: `task ${forkId}`,
    depth: 0,
  });
  expect(result.ok).toBe(true);
  return result.fork;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("scope_join as a ticket", () => {
  test("parks until the child returns, then carries its record", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring);
    const station = stationOf(wiring.registry, ledger);
    opened(ledger, "j1");

    let settled = false;
    const pending = joinTicket(station, "call-j1", {}, {}).then((result) => {
      settled = true;
      return result;
    });
    await tick();
    expect(settled).toBe(false);

    wiring.registry.outcomes.set("j1", {
      record: "the child read the parser",
      failed: false,
      reason: null,
    });
    // The host's completion path marks ready and wakes the parked parent.
    pulse(wiring.registry, ledger, "j1", { failed: false, reason: null });

    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("the child read the parser");
    expect(ledger.forks.j1.status).toBe("joined");
  });

  test("a cancelled wait keeps the child running", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring);
    const station = stationOf(wiring.registry, ledger);
    opened(ledger, "j2");

    const controller = new AbortController();
    const pending = joinTicket(station, "call-j2", {}, {}, controller.signal);
    await tick();
    controller.abort();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("JOIN_INTERRUPTED");
    expect(ledger.forks.j2.status).toBe("running");
  });
});

describe("scope_return as a ticket", () => {
  test("does not claim acceptance before the parent takes the record", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring);
    const station = stationOf(wiring.registry, ledger, {
      forkId: "c1",
      parentOwnerId: "root",
    });
    opened(ledger, "c1", "root");

    let settled = false;
    const pending = returnTicket(station, "call-r1", {}, {}).then((result) => {
      settled = true;
      return result;
    });
    await tick();
    expect(settled).toBe(false);
    expect(ledger.forks.c1.status).toBe("ready");

    const taken = takeReady(ledger, { ownerId: "root" });
    expect(taken.ok).toBe(true);
    // A parent's take is what the child's scope_return is parked on.
    notifyWaiters(wiring.registry);

    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("has been handed to Root");
    expect(result.details.accepted).toBe(true);
    expect(result.details.awaitingReceipt).toBe(false);
  });

  test("a cancelled wait leaves the bracket open", async () => {
    const wiring = createForkWiring();
    const ledger = ledgerFor(wiring);
    const station = stationOf(wiring.registry, ledger, {
      forkId: "c2",
      parentOwnerId: "root",
    });
    opened(ledger, "c2", "root");

    const controller = new AbortController();
    const pending = returnTicket(station, "call-r2", {}, {}, controller.signal);
    await tick();
    controller.abort();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("RETURN_INTERRUPTED");
    expect(ledger.forks.c2.status).toBe("ready");
  });
});

function ledgerFor(wiring) {
  return ledgerForKey(wiring, "blocking");
}

function ledgerForKey(wiring, key) {
  const station = stationOf(wiring.registry, null);
  const attached = attachForkPorts(station, wiring, { conversationKey: key });
  return attached.ledger;
}
