import { expect, test } from "bun:test";
import { handleSendCall } from "../src/station/send-controls.mjs";
import { createBracketLedger, registerFork, markReady, forkOf } from "../src/scope/forkjoin.mjs";
import { planLedgerEntry, foldStateChain } from "../src/scope/persistence.mjs";
import { consumerPending } from "../src/scope/ledger-cache.mjs";

test("a synchronous clock callback sees the queued wake in a persistence pass", () => {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, { forkId: "worker", ownerId: "root", fsm: "work", depth: 0, path: "/worker", budget: { read: 1 }, time: 10 });
  expect(registered.ok).toBe(true);
  markReady(ledger, "worker", { ok: true, record: "done" });
  const state = { brackets: ledger };
  const base = planLedgerEntry(state, null);
  let during;
  const station = {
    state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => null,
    clockPort: () => ({ start() { during = planLedgerEntry(state, base.brackets); } }),
  };
  const result = handleSendCall(station, { id: "s", arguments: { target: "/worker", message: "wake" } });
  expect(result.isError).toBeUndefined();
  expect(during?.entry).toBeTruthy();
  const restored = foldStateChain([base.entry, during.entry]);
  expect(restored.brackets.forks.worker.woken).toBe(true);
  expect(restored.brackets.forks.worker.inbox.at(-1).message).toBe("wake");
  expect(forkOf(ledger, "worker").woken).toBe(true);
});

// The other half of the same door: the clock capability is external code handed
// the live record, so it can write a field and *then* throw. `editRecord` marks
// on that path too, and the exception still reaches the caller — the send is
// abandoned, but the fields it already wrote must not be lost to the next
// snapshot. Asserting the pending set rather than a round trip keeps this test
// about the door's contract instead of about a particular planner call shape.
test("a clock that writes and then throws leaves those writes marked", () => {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId: "worker",
    ownerId: "root",
    fsm: "work",
    depth: 0,
    path: "/worker",
    budget: { read: 1 },
    time: 10,
  });
  expect(registered.ok).toBe(true);
  markReady(ledger, "worker", { ok: true, record: "done" });

  const station = {
    state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
    forkLedgerPort: () => ledger,
    forkIdentityPort: () => null,
    clockPort: () => ({
      start(record) {
        record.startedAt = 123;
        throw new Error("clock failed");
      },
    }),
  };

  expect(() =>
    handleSendCall(station, {
      id: "s",
      arguments: { target: "/worker", message: "wake" },
    }),
  ).toThrow("clock failed");

  const record = forkOf(ledger, "worker");
  // The writes the clock made before failing are still in memory...
  expect(record.startedAt).toBe(123);
  // ...and the mailbox and wake flag written earlier are marked as owed, so a
  // snapshot taken now cannot reuse the copy that predates them.
  expect(record.woken).toBe(true);
  expect(record.inbox.at(-1).message).toBe("wake");
  expect(consumerPending(ledger)?.records ?? []).toContain("worker");
});
