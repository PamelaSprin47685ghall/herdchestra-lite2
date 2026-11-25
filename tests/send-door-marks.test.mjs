// A send writes four fields on one shared record: the envelope, the wake flag,
// the granted turns, and the restarted clock. The record mutation door makes
// the dirty mark part of the edit. It does not provide isolation from a
// synchronously reentrant clock port.
//
// These cases drive the real handler and ask the ledger, not the record, what a
// reload would see: the mark is the contract, and reading the live object would
// pass even when nothing was marked.

import { describe, expect, test } from "bun:test";

import { handleSendCall } from "../src/station/send-controls.mjs";
import {
  createState,
  createBracketLedger,
  registerFork,
  planLedgerEntry,
  foldStateChain,
} from "../src/scope/index.mjs";
import { registerLedger, ledgerPending } from "../src/scope/ledger-cache.mjs";

function ledgerWith(ids) {
  const ledger = createBracketLedger();
  registerLedger(ledger);
  for (const forkId of ids) {
    const registered = registerFork(ledger, {
      forkId,
      ownerId: "root",
      fsm: "one state",
      depth: 0,
      budget: { read: 2 },
      profession: "You are a tester.",
    });
    expect(registered.ok).toBe(true);
    registered.fork.path = `/${forkId}`;
  }
  return ledger;
}

/** A station whose only real state is the ledger under test. */
function stationFor(ledger, overrides = {}) {
  return {
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => ({ forkId: "self", path: "/sender" }),
    ...overrides,
  };
}

function send(station, args) {
  return handleSendCall(station, { id: "send", arguments: args });
}

function recordOf(ledger, forkId) {
  return ledger.forks[forkId];
}

/** What a reload of the journal would show for one fork. */
function reloaded(ledger, forkId) {
  const state = { brackets: ledger };
  const plan = planLedgerEntry(state, null);
  const folded = foldStateChain([plan.entry].filter(Boolean));
  return folded?.brackets.forks[forkId] ?? null;
}

describe("a delivered envelope", () => {
  test("is owed to the journal, not only to memory", () => {
    const ledger = ledgerWith(["worker"]);
    const station = stationFor(ledger);

    const result = send(station, { target: "/worker", message: "start" });
    expect(result.isError).toBeUndefined();
    expect(recordOf(ledger, "worker").inbox.length).toBe(1);

    // The mark is the contract: without it the snapshot keeps a record with an
    // empty inbox and the message is lost on reload, silently.
    const pending = ledgerPending(ledger);
    expect(pending).not.toBeNull();
    expect(pending.records).toContain("worker");

    expect(reloaded(ledger, "worker").inbox[0].message).toBe("start");
  });

  test("keeps the sender and the envelope together", () => {
    const ledger = ledgerWith(["worker"]);
    send(stationFor(ledger), { target: "/worker", message: "hello" });

    const delivered = reloaded(ledger, "worker").inbox[0];
    expect(delivered.from).toBe("/sender");
    expect(delivered.message).toBe("hello");
    expect(delivered.envelope).toBe("[Message from /sender]\nhello");
  });
});

describe("a wake", () => {
  test("sets the flag and marks the record in one step", () => {
    const ledger = ledgerWith(["worker"]);
    // Not running: this is the wake path.
    recordOf(ledger, "worker").status = "ready";
    const woken = [];
    const station = stationFor(ledger, {
      childWakePort: () => (forkId) => woken.push(forkId),
    });

    const result = send(station, { target: "/worker", message: "again" });
    expect(result.isError).toBeUndefined();

    const record = recordOf(ledger, "worker");
    expect(record.woken).toBe(true);
    expect(woken).toEqual(["worker"]);

    // Both fields travel in the same edit, so the stored record has both.
    const restored = reloaded(ledger, "worker");
    expect(restored.woken).toBe(true);
    expect(restored.inbox.map((item) => item.message)).toEqual(["again"]);
  });

  test("leaves a running scope's wake flag untouched", () => {
    const ledger = ledgerWith(["worker"]);
    recordOf(ledger, "worker").status = "running";
    const woken = [];

    send(stationFor(ledger, { childWakePort: () => (id) => woken.push(id) }), {
      target: "/worker",
      message: "continue",
    });

    expect(recordOf(ledger, "worker").woken ?? false).toBe(false);
    expect(woken).toEqual([]);
    expect(reloaded(ledger, "worker").inbox.length).toBe(1);
  });
});

describe("granted turns", () => {
  test("raise both the ceiling and what is left, and are persisted", () => {
    const ledger = ledgerWith(["worker"]);
    const before = { ...recordOf(ledger, "worker").remaining };

    const result = send(stationFor(ledger), {
      target: "/worker",
      message: "more budget",
      budget: { read: 3 },
    });
    expect(result.isError).toBeUndefined();

    const record = recordOf(ledger, "worker");
    expect(record.budget.read).toBe(5);
    expect(record.remaining.read).toBe((before.read ?? 0) + 3);

    // The grant is part of the same edit as the envelope, so one reload shows
    // both; a grant marked apart from its message would be able to land alone.
    const restored = reloaded(ledger, "worker");
    expect(restored.budget.read).toBe(5);
    expect(restored.remaining.read).toBe((before.read ?? 0) + 3);
    expect(restored.inbox.length).toBe(1);
  });

  test("a zero-only budget grants nothing and still delivers", () => {
    const ledger = ledgerWith(["worker"]);
    const before = { ...recordOf(ledger, "worker").budget };

    send(stationFor(ledger), {
      target: "/worker",
      message: "no extra turns",
      budget: { read: 0 },
    });

    expect(recordOf(ledger, "worker").budget).toEqual(before);
    expect(reloaded(ledger, "worker").inbox.length).toBe(1);
  });
});
