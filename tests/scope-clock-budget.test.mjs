import { describe, expect, test } from "bun:test";
import {
  createBracketLedger,
  forkBudgetText,
  registerFork,
  reviveBlockedFork,
} from "../src/scope/forkjoin.mjs";
import { createClockOn } from "../src/scope/clock.mjs";

function blockedFork({ timeSeconds = 10, now = 1_000_000 } = {}) {
  const ledger = createBracketLedger();
  const registered = registerFork(
    ledger,
    {
      forkId: "fork_blocked",
      scopeId: "child",
      ownerId: "parent",
      intent: "wait for a prerequisite",
      depth: 0,
      time: timeSeconds,
      blocked: true,
    },
    { clock: createClockOn(() => now) },
  );
  expect(registered.ok).toBe(true);
  return { ledger, record: registered.fork };
}

describe("blocked fork clock", () => {
  test("queue time never spends the grant", () => {
    const { ledger, record } = blockedFork({ timeSeconds: 10, now: 1_000_000 });
    // Registered at t=1000s, revived 60s later.
    const revivedAt = 1_060_000;
    const revived = reviveBlockedFork(ledger, "fork_blocked", revivedAt);
    expect(revived.ok).toBe(true);
    expect(record.status).toBe("running");
    expect(record.deadlineAt).toBe(revivedAt + 10_000);
    expect(record.startedAt).toBe(revivedAt);
  });

  test("an unbounded blocked fork stays unbounded", () => {
    const ledger = createBracketLedger();
    const registered = registerFork(
      ledger,
      {
        forkId: "fork_open",
        scopeId: "child",
        ownerId: "parent",
        intent: "no deadline",
        depth: 0,
        blocked: true,
      },
      { clock: createClockOn(() => 1_000_000) },
    );
    expect(registered.ok).toBe(true);
    reviveBlockedFork(ledger, "fork_open", 1_060_000);
    expect(registered.fork.deadlineAt).toBeNull();
  });
});

describe("remaining clock rendering", () => {
  test("floors the remaining seconds instead of rounding up", () => {
    const ledger = createBracketLedger();
    const registered = registerFork(
      ledger,
      {
        forkId: "fork_render",
        scopeId: "child",
        ownerId: "parent",
        intent: "render",
        depth: 0,
        time: 60,
        startedAt: 1_000_000,
      },
      { clock: createClockOn(() => 1_000_000) },
    );
    expect(registered.ok).toBe(true);
    // 57.1s left must read 0:57, not 0:58.
    const line = forkBudgetText(registered.fork, 1_002_900);
    expect(line).toContain("time 0:57/1:00");
  });
});
