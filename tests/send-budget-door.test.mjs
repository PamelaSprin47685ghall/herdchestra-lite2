// Granting turns is a record change like any other, and it has to reach the
// journal through the same door as the envelope.
//
// `grantTurns` writes two fields per tool — the ceiling and what is left — on
// a record that `forkOf` handed out. It is called from inside the send path's
// `editRecord` callback, so the mark is the enclosing edit's. That containment
// is what these cases pin: if the call ever moves outside the callback, the
// granted turns stay in memory and the journal keeps the old budget, and a
// reload then reports a branch with turns it was never given — or, worse,
// refuses turns it was.
//
// The write is pinned behaviourally (what a reload shows), not by reading the
// source: a test that greps for the call would pass while the call moved to a
// place that no longer marks.

import { describe, expect, test } from "bun:test";

import { handleSendCall } from "../src/station/send-controls.mjs";
import {
  createBracketLedger,
  registerFork,
  foldStateChain,
} from "../src/scope/index.mjs";
import { forkOf, markReady } from "../src/scope/forkjoin.mjs";
import { createClockOn } from "../src/scope/clock.mjs";
import { registerLedger } from "../src/scope/ledger-cache.mjs";
import { planLedgerEntry } from "../src/scope/persistence.mjs";

const TARGET = "f-worker";

function ledgerWithWorker(status = "running") {
  const ledger = createBracketLedger();
  registerLedger(ledger);
  const registered = registerFork(ledger, {
    forkId: TARGET,
    ownerId: "root",
    fsm: "one state",
    depth: 0,
    budget: { read: 1 },
    profession: "You are a worker.",
  });
  expect(registered.ok).toBe(true);
  registered.fork.path = "/worker";
  // The sender is a real registered scope. The send path resolves where it
  // speaks from by looking its own fork up in the ledger, so a station naming a
  // fork the ledger never heard of falls back to `/` and cannot address a child.
  const sender = registerFork(ledger, {
    forkId: "f-api",
    ownerId: "root",
    fsm: "task f-api",
    depth: 0,
  });
  expect(sender.ok).toBe(true);
  sender.fork.path = "/api";
  if (status === "ready") markReady(ledger, TARGET, { ok: true, record: "idle" });
  return ledger;
}

function stateWith(ledger) {
  return { brackets: ledger };
}

/**
 * The station shape the send path actually reads: the ledger and this station's
 * identity arrive through ports, not as fields on the station.
 */
function stationFor(ledger) {
  return {
    state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => ({ forkId: "f-api", path: "/api" }),
    // The wake path restarts a finished scope's clock through the port it is
    // given. A station without one leaves the deadline untouched, so the port is
    // part of the shape under test, not a convenience.
    clockPort: () => createClockOn(),
  };
}

function reload(entries) {
  const folded = foldStateChain(entries);
  return folded === null ? null : folded.brackets.forks[TARGET];
}

function send(station, args) {
  return handleSendCall(station, { id: "send-1", arguments: args });
}

describe("granted turns reach the journal", () => {
  test("a station without a clock port spends no mark restarting nothing", () => {
    const ledger = ledgerWithWorker("ready");
    const state = stateWith(ledger);
    const base = planLedgerEntry(state, null);
    // No clockPort: the wake path has nothing to restart, so it must not mark
    // the record as moved. A spurious mark re-copies the whole record into the
    // next snapshot, which for a long inbox is the cost this door exists to
    // avoid — but the assertion is about correctness first: a mark that stands
    // for no write makes the journal restate a record nothing changed.
    const station = stationFor(ledger);
    delete station.clockPort;
    const result = send(station, { target: "/worker", message: "wake up" });
    expect(result.isError).toBeUndefined();
    expect(forkOf(ledger, TARGET).deadlineAt).toBeNull();

    const next = planLedgerEntry(state, base.brackets);
    expect(next.entry).not.toBeNull();
    const restored = reload([base.entry, next.entry]);
    // The envelope and the wake flag still landed; only the absent clock left
    // no trace, which is exactly what happened.
    expect(restored.woken).toBe(true);
    expect(restored.inbox.map((item) => item.message)).toEqual(["wake up"]);
    expect(restored.deadlineAt).toBeNull();
  });

  test("a budget grant is persisted alongside the envelope", () => {
    const ledger = ledgerWithWorker();
    const state = stateWith(ledger);
    const base = planLedgerEntry(state, null);
    expect(base.entry).toBeTruthy();

    const result = send(
      stationFor(ledger),
      { target: "/worker", message: "more work", budget: { read: 2 } },
    );
    expect(result.isError).toBeUndefined();

    // The live record took the grant: ceiling and remainder both move, which is
    // the arithmetic a freshly minted branch uses.
    const live = forkOf(ledger, TARGET);
    expect(live.budget.read).toBe(3);
    expect(live.remaining.read).toBe(3);

    const next = planLedgerEntry(state, base.brackets);
    expect(next.entry, "the grant must be owed to the journal").not.toBeNull();

    const restored = reload([base.entry, next.entry]);
    expect(restored.budget.read).toBe(3);
    expect(restored.remaining.read).toBe(3);
    // The envelope that shared the step is there too: one edit carried both.
    expect(restored.inbox.map((item) => item.message)).toEqual(["more work"]);
  });

  test("the grant and the envelope cannot land apart", () => {
    const ledger = ledgerWithWorker();
    const state = stateWith(ledger);
    const base = planLedgerEntry(state, null);

    const result = send(
      stationFor(ledger),
      { target: "/worker", message: "one more", budget: { read: 1 } },
    );
    expect(result.isError).toBeUndefined();

    const next = planLedgerEntry(state, base.brackets);
    const restored = reload([base.entry, next.entry]);

    // Both halves are in the same folded record: a journal holding the turn but
    // not the message would be a step applied halfway.
    expect(restored.budget.read).toBe(2);
    expect(restored.inbox.length).toBe(1);

    // And the baseline alone has neither, so the entry is load-bearing for both.
    const baselineOnly = reload([base.entry]);
    expect(baselineOnly.budget.read).toBe(1);
    expect(baselineOnly.inbox.length).toBe(0);
  });

  test("waking a finished scope grants turns and restarts its clock in one step", () => {
    const ledger = ledgerWithWorker("ready");
    const state = stateWith(ledger);
    const base = planLedgerEntry(state, null);

    // A bounded branch: the wake path restarts this clock, since a finished
    // scope's deadline has already run out.
    forkOf(ledger, TARGET).timeBudgetMs = 60_000;

    const result = send(
      stationFor(ledger),
      { target: "/worker", message: "wake up", budget: { read: 1 } },
    );
    expect(result.isError).toBeUndefined();

    const live = forkOf(ledger, TARGET);
    expect(live.woken).toBe(true);
    expect(live.status).not.toBe("running");
    expect(live.deadlineAt).toBeGreaterThan(0);

    const next = planLedgerEntry(state, base.brackets);
    expect(next.entry).not.toBeNull();
    const restored = reload([base.entry, next.entry]);

    // Wake flag, restarted deadline and the granted turn are one persisted step.
    expect(restored.woken).toBe(true);
    expect(restored.deadlineAt).toBe(live.deadlineAt);
    expect(restored.budget.read).toBe(2);
    expect(restored.inbox.map((item) => item.message)).toEqual(["wake up"]);
  });

  test("a grant to a running scope does not wake it", () => {
    const ledger = ledgerWithWorker();
    const state = stateWith(ledger);
    const base = planLedgerEntry(state, null);

    send(
      stationFor(ledger),
      { target: "/worker", message: "keep going", budget: { read: 1 } },
    );

    const next = planLedgerEntry(state, base.brackets);
    const restored = reload([base.entry, next.entry]);
    // A running branch is not woken and its clock is untouched: the grant is a
    // budget change, not a restart.
    expect(restored.woken).toBe(false);
    expect(restored.deadlineAt).toBeNull();
    expect(restored.budget.read).toBe(2);
  });

  test("an invalid budget is refused before anything is written", () => {
    const ledger = ledgerWithWorker();
    const state = stateWith(ledger);
    const base = planLedgerEntry(state, null);

    const result = send(
      stationFor(ledger),
      { target: "/worker", message: "bad grant", budget: { read: -1 } },
    );
    expect(result.isError).toBe(true);

    // Neither the envelope nor a grant was written, so the journal owes nothing.
    const next = planLedgerEntry(state, base.brackets);
    expect(next.entry).toBeNull();
    const restored = reload([base.entry]);
    expect(restored.budget.read).toBe(1);
    expect(restored.inbox.length).toBe(0);
  });
});
