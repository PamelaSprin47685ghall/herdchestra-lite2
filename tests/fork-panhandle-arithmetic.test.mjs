// A branch that runs out must be able to buy its own way forward.
//
// The consumer is the branch itself: it calls scope_panhandle after the host has
// refused a tool, and the next normal call must run without waiting for a
// parent decision. The parent's consumer view is the account text: it must
// show the larger budget and how often the branch had to ask.

import { describe, expect, test } from "bun:test";

import { beatShares, isFreeTool } from "../src/scope/budget.mjs";
import { createClockOn, toolLimitOf } from "../src/scope/clock.mjs";
import {
  applyCharge,
  createBracketLedger,
  forkBudgetText,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import {
  applyPanhandle,
  PANHANDLE_DEFAULT_POINTS,
  PANHANDLE_MAX_POINTS,
  PANHANDLE_MAX_SECONDS,
} from "../src/scope/panhandle.mjs";

function ledgerWith(overrides = {}) {
  const clock = createClockOn(() => 1_000);
  const ledger = createBracketLedger();
  const out = registerFork(
    ledger,
    {
      forkId: "f1",
      ownerId: "root",
      knuth_nfa_inspired_fsm: "finish the work",
      depth: 0,
      budget: { read: 2, bash: 1 },
      time: 60,
      startedAt: 1_000,
      ...overrides,
    },
    { clock },
  );
  if (!out.ok) throw new Error(out.reason);
  return { ledger, record: out.fork, clock };
}

describe("a panhandle lands on the branch's own account", () => {
  test("points are added to the budget and the remaining balance", () => {
    const { ledger, record } = ledgerWith();
    const out = applyPanhandle(ledger, "f1", { tools: { read: 3 } }, { now: 5_000 });
    expect(out.ok).toBe(true);
    expect(record.budget.read).toBe(5);
    expect(record.remaining.read).toBe(5);
    expect(record.spent.read).toBe(0);
    expect(record.remaining.bash).toBe(1);
    expect(record.panhandles).toEqual([
      { at: 5_000, tools: { read: 3 }, seconds: 0 },
    ]);
  });

  test("a tool the fork never declared starts at zero on both sides", () => {
    const { ledger, record, clock } = ledgerWith();
    applyPanhandle(ledger, "f1", { tools: { grep: 2 } }, { now: 2_000 });
    expect(record.budget.grep).toBe(2);
    expect(record.remaining.grep).toBe(2);
    expect(forkBudgetText(record, 2_000, clock)).toContain("grep 2.00/2.00");
  });

  test("the parent's account does not shrink", () => {
    const clock = createClockOn(() => 1_000);
    const ledger = createBracketLedger();
    registerFork(ledger, {
      forkId: "p1",
      ownerId: "root",
      knuth_nfa_inspired_fsm: "parent",
      depth: 0,
      budget: { read: 5 },
      time: 60,
      startedAt: 1_000,
    }, { clock });
    registerFork(ledger, {
      forkId: "c1",
      ownerId: "p1",
      knuth_nfa_inspired_fsm: "child",
      depth: 1,
      budget: { read: 0 },
      time: 60,
      startedAt: 1_000,
    }, { clock });
    const parent = ledger.forks.p1;
    applyPanhandle(ledger, "c1", { tools: { read: 4 } }, { now: 2_000 });
    expect(ledger.forks.c1.remaining.read).toBe(4);
    expect(parent.remaining.read).toBe(5);
    expect(parent.budget.read).toBe(5);
  });

  test("seconds move the deadline and end overtime", () => {
    const { ledger, record } = ledgerWith();
    expect(toolLimitOf(record, 70_000)).toBe(1_000);
    expect(record.overtimeAt).toBe(70_000);

    const out = applyPanhandle(ledger, "f1", { seconds: 30 }, { now: 70_000 });
    expect(out.ok).toBe(true);
    expect(record.timeBudgetMs).toBe(90_000);
    expect(record.deadlineAt).toBe(91_000);
    expect(record.overtimeAt).toBeNull();
    expect(toolLimitOf(record, 70_000)).toBe(22_000);
  });

  test("a paused clock still gets the full grant after resume", () => {
    const { ledger, record, clock } = ledgerWith();
    clock.pause(record, 5_000);
    applyPanhandle(ledger, "f1", { seconds: 30 }, { now: 8_000 });
    expect(record.deadlineAt).toBe(91_000);
    clock.resume(record, 11_000);
    expect(record.deadlineAt).toBe(97_000);
    expect(record.pausedMs).toBe(6_000);
  });

  test("every grant is counted in the account text", () => {
    const { ledger, record, clock } = ledgerWith();
    applyPanhandle(ledger, "f1", { tools: { read: 1 } }, { now: 2_000 });
    applyPanhandle(ledger, "f1", { tools: { read: 1 } }, { now: 3_000 });
    expect(record.panhandles).toHaveLength(2);
    expect(forkBudgetText(record, 4_000, clock)).toContain("panhandled 2x");
  });

  test("the panhandle tool itself is free, so an empty branch can call it", () => {
    expect(isFreeTool("scope_panhandle")).toBe(true);
  });

  test("a panhandle in the same beat does not dilute a paid tool's share", () => {
    const shares = beatShares([
      { name: "scope_panhandle", free: isFreeTool("scope_panhandle") },
      { name: "read", free: isFreeTool("read") },
    ]);
    expect(shares).toEqual({ read: 1 });
  });

  test("a granted tool can be charged on the next call", () => {
    const { ledger, record } = ledgerWith();
    applyPanhandle(ledger, "f1", { tools: { grep: 2 } }, { now: 2_000 });
    const charged = applyCharge(ledger, "f1", {
      tool: "grep",
      toolCallId: "call-1",
      amount: 1,
    });
    expect(charged.ok).toBe(true);
    expect(record.remaining.grep).toBe(1);
    expect(record.spent.grep).toBe(1);
  });
});

describe("a refusal states the rule and changes nothing", () => {
  function unchanged(ledger, record) {
    expect(record.budget).toEqual({ read: 2, bash: 1 });
    expect(record.remaining).toEqual({ read: 2, bash: 1 });
    expect(record.panhandles).toBeUndefined();
    expect(ledger.forks.f1).toBe(record);
  }

  test("an empty request", () => {
    const { ledger, record } = ledgerWith();
    const out = applyPanhandle(ledger, "f1", {});
    expect(out.code).toBe("PANHANDLE_EMPTY");
    unchanged(ledger, record);
  });

  test("a grant above the per-call point cap lands and reports the overage", () => {
    const { ledger, record } = ledgerWith();
    expect(PANHANDLE_DEFAULT_POINTS).toBe(6);
    expect(PANHANDLE_MAX_POINTS).toBe(9);
    expect(PANHANDLE_DEFAULT_POINTS).toBeLessThan(PANHANDLE_MAX_POINTS);
    const atCap = applyPanhandle(ledger, "f1", { tools: { read: PANHANDLE_MAX_POINTS } }, { now: 2_000 });
    expect(atCap.ok).toBe(true);
    expect(atCap.overLimit).toBe(false);
    expect(atCap.pointsRequested).toBe(PANHANDLE_MAX_POINTS);

    const out = applyPanhandle(ledger, "f1", {
      tools: { bash: PANHANDLE_MAX_POINTS + 1 },
    }, { now: 3_000 });
    expect(out.ok).toBe(true);
    expect(out.overLimit).toBe(true);
    expect(out.pointsRequested).toBe(PANHANDLE_MAX_POINTS + 1);
    expect(record.budget.bash).toBe(1 + PANHANDLE_MAX_POINTS + 1);
    expect(record.remaining.bash).toBe(1 + PANHANDLE_MAX_POINTS + 1);
  });

  test("the cap counts the whole request, not each tool", () => {
    const { ledger, record } = ledgerWith();
    const split = applyPanhandle(ledger, "f1", { tools: { grep: 5, read: 5 } }, { now: 2_000 });
    expect(split.ok).toBe(true);
    expect(split.overLimit).toBe(true);
    expect(split.pointsRequested).toBe(10);
    expect(record.budget.grep).toBe(5);
    expect(record.budget.read).toBe(7);
  });

  test("a fractional or negative point", () => {
    const { ledger, record } = ledgerWith();
    expect(applyPanhandle(ledger, "f1", { tools: { read: 1.5 } }).code).toBe(
      "PANHANDLE_INVALID_TOOLS",
    );
    expect(applyPanhandle(ledger, "f1", { tools: { read: -1 } }).code).toBe(
      "PANHANDLE_INVALID_TOOLS",
    );
    unchanged(ledger, record);
  });

  test("a free tool cannot be granted", () => {
    const { ledger, record } = ledgerWith();
    const out = applyPanhandle(ledger, "f1", { tools: { ask: 1 } });
    expect(out.code).toBe("PANHANDLE_FREE_TOOL");
    unchanged(ledger, record);
  });

  test("a grant above the per-call seconds cap", () => {
    const { ledger, record } = ledgerWith();
    const out = applyPanhandle(ledger, "f1", { seconds: PANHANDLE_MAX_SECONDS + 1 });
    expect(out.code).toBe("PANHANDLE_SECONDS_LIMIT");
    unchanged(ledger, record);
  });

  test("a blocked branch must raise its declaration on resubmit", () => {
    const { ledger, record } = ledgerWith({ blocked: true });
    const out = applyPanhandle(ledger, "f1", { tools: { read: 1 } });
    expect(out.code).toBe("PANHANDLE_BLOCKED");
    unchanged(ledger, record);
  });

  test("a branch without a wall clock can buy tools but not seconds", () => {
    const { ledger, record } = ledgerWith({ time: undefined });
    expect(record.deadlineAt).toBeNull();
    expect(applyPanhandle(ledger, "f1", { seconds: 10 }).code).toBe(
      "PANHANDLE_CLOCK_OFF",
    );
    expect(applyPanhandle(ledger, "f1", { tools: { read: 1 } }).ok).toBe(true);
    expect(record.remaining.read).toBe(3);
  });

  test("an unknown fork", () => {
    const { ledger } = ledgerWith();
    expect(applyPanhandle(ledger, "nope", { tools: { read: 1 } }).code).toBe(
      "UNKNOWN_FORK",
    );
  });
});
