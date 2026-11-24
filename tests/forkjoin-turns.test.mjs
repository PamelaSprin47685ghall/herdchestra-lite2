import { describe, expect, test } from "bun:test";

import {
  applyCharge,
  applyRefund,
  createBracketLedger,
  forkBudgetText,
  forkOf,
  registerFork,
} from "../src/scope/forkjoin.mjs";
import {
  createClockOn,
  deadlineInfo,
  pauseClock,
  resumeClock,
} from "../src/scope/clock.mjs";

function fork(ledger, spec = {}) {
  const result = registerFork(ledger, {
    forkId: spec.forkId ?? "f1",
    ownerId: spec.ownerId ?? "root",
    fsm: spec.fsm ?? "task",
    depth: spec.depth ?? 0,
    budget: spec.budget,
    time: spec.time,
    startedAt: spec.startedAt,
  }, { clock: createClockOn() });
  expect(result.ok).toBe(true);
  return result.fork;
}

describe("fork budget registration", () => {
  test("stores the budget, the remaining turns, and the spent zeroes", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, { budget: { read: 4, bash: 2 }, time: 180, startedAt: 1000 });
    expect(record.budget).toEqual({ read: 4, bash: 2 });
    expect(record.remaining).toEqual({ read: 4, bash: 2 });
    expect(record.spent).toEqual({ read: 0, bash: 0 });
    expect(record.timeBudgetMs).toBe(180000);
    expect(record.deadlineAt).toBe(181000);
    expect(record.charges).toEqual({});
  });

  test("a fork without a budget owns no turns and no deadline", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger);
    expect(record.budget).toEqual({});
    expect(record.remaining).toEqual({});
    expect(record.deadlineAt).toBeNull();
  });

  test("refuses a malformed budget before the bracket exists", () => {
    const ledger = createBracketLedger();
    for (const budget of [null, "read 2", { read: -1 }, { read: 1.5 }]) {
      const result = registerFork(ledger, {
        forkId: `f-${String(budget)}`,
        ownerId: "root",
        fsm: "task",
        depth: 0,
        budget,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("INVALID_BUDGET");
    }
    expect(ledger.order).toEqual([]);
  });

  test("refuses a non-positive time before the bracket exists", () => {
    const ledger = createBracketLedger();
    for (const time of [0, -5, Number.NaN, "30"]) {
      const result = registerFork(ledger, {
        forkId: `t-${String(time)}`,
        ownerId: "root",
        fsm: "task",
        depth: 0,
        time,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("INVALID_TIME");
    }
  });
});

describe("fork charging", () => {
  test("one call spends its share and reports the remaining turns", () => {
    const ledger = createBracketLedger();
    fork(ledger, { budget: { read: 4 } });
    const charged = applyCharge(ledger, "f1", {
      toolCallId: "c1",
      tool: "read",
      amount: 0.5,
    });
    expect(charged.ok).toBe(true);
    expect(charged.amount).toBe(0.5);
    expect(forkOf(ledger, "f1").remaining.read).toBe(3.5);
    expect(forkOf(ledger, "f1").spent.read).toBe(0.5);
  });

  test("the same tool call is charged once, however often it is reported", () => {
    const ledger = createBracketLedger();
    fork(ledger, { budget: { read: 4 } });
    applyCharge(ledger, "f1", { toolCallId: "c1", tool: "read", amount: 1 });
    const again = applyCharge(ledger, "f1", { toolCallId: "c1", tool: "read", amount: 1 });
    expect(again.ok).toBe(true);
    expect(again.alreadyCharged).toBe(true);
    expect(forkOf(ledger, "f1").remaining.read).toBe(3);
  });

  test("the same beat group is charged once across its calls", () => {
    const ledger = createBracketLedger();
    fork(ledger, { budget: { read: 4 } });
    applyCharge(ledger, "f1", { toolCallId: "c1", tool: "read", amount: 0.5, groupKey: "beat-1" });
    const again = applyCharge(ledger, "f1", { toolCallId: "c2", tool: "read", amount: 0.5, groupKey: "beat-1" });
    expect(again.ok).toBe(true);
    expect(again.alreadyCharged).toBe(true);
    expect(forkOf(ledger, "f1").remaining.read).toBe(3.5);
  });

  test("an exhausted tool refuses the next call and names the budget", () => {
    const ledger = createBracketLedger();
    fork(ledger, { budget: { read: 0 } });
    const refused = applyCharge(ledger, "f1", { toolCallId: "c1", tool: "read", amount: 1 });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("BUDGET_EXHAUSTED");
    expect(refused.tool).toBe("read");
    expect(forkOf(ledger, "f1").remaining.read).toBe(0);
  });

  test("a share larger than the budget spends what is left", () => {
    const ledger = createBracketLedger();
    fork(ledger, { budget: { read: 1 } });
    const charged = applyCharge(ledger, "f1", { toolCallId: "c1", tool: "read", amount: 1.5 });
    expect(charged.ok).toBe(true);
    expect(charged.amount).toBe(1);
    expect(forkOf(ledger, "f1").remaining.read).toBe(0);
  });

  test("a tool absent from the budget refuses without touching another budget", () => {
    const ledger = createBracketLedger();
    fork(ledger, { budget: { read: 2 } });
    const refused = applyCharge(ledger, "f1", { toolCallId: "c1", tool: "bash", amount: 1 });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("BUDGET_EXHAUSTED");
    expect(forkOf(ledger, "f1").remaining.read).toBe(2);
  });

  test("an unknown fork refuses the charge", () => {
    const ledger = createBracketLedger();
    const refused = applyCharge(ledger, "missing", { toolCallId: "c1", tool: "read", amount: 1 });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("UNKNOWN_FORK");
  });
});

describe("fork refunding", () => {
  test("an amended charge returns to the budget", () => {
    const ledger = createBracketLedger();
    fork(ledger, { budget: { read: 4 } });
    applyCharge(ledger, "f1", { toolCallId: "c1", tool: "read", amount: 1 });
    const refunded = applyRefund(ledger, "f1", "c1");
    expect(refunded.ok).toBe(true);
    expect(refunded.refunded).toBe(1);
    expect(forkOf(ledger, "f1").remaining.read).toBe(4);
    expect(forkOf(ledger, "f1").spent.read).toBe(0);
  });

  test("a repeated refund changes nothing", () => {
    const ledger = createBracketLedger();
    fork(ledger, { budget: { read: 4 } });
    applyCharge(ledger, "f1", { toolCallId: "c1", tool: "read", amount: 1 });
    applyRefund(ledger, "f1", "c1");
    const again = applyRefund(ledger, "f1", "c1");
    expect(again.ok).toBe(true);
    expect(again.refunded).toBe(0);
    expect(forkOf(ledger, "f1").remaining.read).toBe(4);
  });

  test("a refund never exceeds what the call spent", () => {
    const ledger = createBracketLedger();
    fork(ledger, { budget: { read: 4 } });
    applyCharge(ledger, "f1", { toolCallId: "c1", tool: "read", amount: 0.5 });
    const refunded = applyRefund(ledger, "f1", "c1");
    expect(refunded.refunded).toBe(0.5);
    expect(forkOf(ledger, "f1").remaining.read).toBe(4);
  });
});

describe("fork deadline", () => {
  test("a fork without a time budget is unbounded", () => {
    const ledger = createBracketLedger();
    fork(ledger);
    expect(deadlineInfo(forkOf(ledger, "f1"), 5000)).toEqual({ bounded: false });
  });

  test("before the deadline the clock reports the remaining milliseconds", () => {
    const ledger = createBracketLedger();
    fork(ledger, { time: 60, startedAt: 0 });
    const info = deadlineInfo(forkOf(ledger, "f1"), 20000);
    expect(info).toEqual({ bounded: true, overtime: false, leftMs: 40000 });
  });

  test("at the deadline the fork is overtime, never one second short", () => {
    const ledger = createBracketLedger();
    fork(ledger, { time: 60, startedAt: 0 });
    expect(deadlineInfo(forkOf(ledger, "f1"), 60000).overtime).toBe(true);
    expect(deadlineInfo(forkOf(ledger, "f1"), 61000).overtime).toBe(true);
  });
});

describe("a paused clock", () => {
  test("freezes the remaining time and shifts the deadline by the paused span", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, { time: 60, startedAt: 0 });
    expect(pauseClock(record, 10000)).toBe(true);
    // While paused, later wall-clock reads see the pause edge, not "now".
    expect(deadlineInfo(record, 20000)).toEqual({
      bounded: true,
      overtime: false,
      leftMs: 50000,
    });
    expect(deadlineInfo(record, 59000).leftMs).toBe(50000);
    expect(resumeClock(record, 20000)).toBe(true);
    expect(record.deadlineAt).toBe(70000);
    expect(deadlineInfo(record, 20000).leftMs).toBe(50000);
    expect(deadlineInfo(record, 65000).leftMs).toBe(5000);
  });

  test("the first pause edge wins and a repeated pause changes nothing", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, { time: 60, startedAt: 0 });
    expect(pauseClock(record, 10000)).toBe(true);
    expect(pauseClock(record, 12000)).toBe(false);
    expect(resumeClock(record, 15000)).toBe(true);
    expect(record.deadlineAt).toBe(65000);
  });

  test("a fork without a clock cannot pause", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger);
    expect(pauseClock(record, 1)).toBe(false);
    expect(resumeClock(record, 2)).toBe(false);
  });

  test("resuming without a pause leaves the deadline untouched", () => {
    const ledger = createBracketLedger();
    const record = fork(ledger, { time: 60, startedAt: 0 });
    expect(resumeClock(record, 9000)).toBe(false);
    expect(record.deadlineAt).toBe(60000);
  });
});

describe("fork turns text", () => {
  test("renders each tool's turns and the clock", () => {
    const ledger = createBracketLedger();
    fork(ledger, { budget: { read: 4, bash: 2 }, time: 120, startedAt: 0 });
    applyCharge(ledger, "f1", { toolCallId: "c1", tool: "read", amount: 1 });
    const text = forkBudgetText(forkOf(ledger, "f1"), 30000);
    expect(text).toBe("bash remaining 2.00/2.00, read remaining 3.00/4.00, time remaining 1:30/2:00");
  });

  test("a fork with no turns renders nothing", () => {
    const ledger = createBracketLedger();
    fork(ledger);
    expect(forkBudgetText(forkOf(ledger, "f1"), 0)).toBe("");
  });
});
