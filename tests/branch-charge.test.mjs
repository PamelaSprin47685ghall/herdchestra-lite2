import { describe, expect, test } from "bun:test";

import { chargeBranch } from "../src/scope/accounting.mjs";
import { createBracketLedger, registerFork } from "../src/scope/forkjoin.mjs";
import { createState } from "../src/scope/state.mjs";

function state() {
  return createState();
}

function ledgerWith(forkId, budget) {
  const ledger = createBracketLedger();
  const registered = registerFork(ledger, {
    forkId,
    ownerId: "root",
    fsm: "task",
    depth: 0,
    budget,
    startedAt: 0,
  });
  expect(registered.ok).toBe(true);
  return ledger;
}

describe("branch charging", () => {
  test("the root branch refuses an ordinary tool because it owns no budget", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 2 });
    const charged = chargeBranch(s, ledger, {
      ownerId: null,
      toolCallId: "c1",
      toolName: "read",
    });
    expect(charged.ok).toBe(false);
    expect(charged.code).toBe("ROOT_HAS_NO_BUDGET");
    expect(charged.reason).toContain("scope_fork");
    expect(ledger.forks.f1.spent).toEqual({ read: 0 });
  });

  test("the root cannot apply a staged edit directly", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 2 });
    const refused = chargeBranch(s, ledger, {
      ownerId: null,
      toolCallId: "a1",
      toolName: "ast_edit",
    });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("ROOT_HAS_NO_BUDGET");
    expect(ledger.forks.f1.spent).toEqual({ read: 0 });
  });

  test("the root still runs free control tools and free protocol reads", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 2 });
    for (const [toolName, input] of [
      ["scope_abandon", { target: "/api" }],
      ["scope_fork", { forks: [] }],
      ["read", { path: "skill://tdd-crowdsource" }],
      ["write", { path: "xd://resolve" }],
      ["write", { path: "xd://reject" }],
    ]) {
      const charged = chargeBranch(s, ledger, {
        ownerId: null,
        toolCallId: `free-${toolName}`,
        toolName,
        input,
      });
      expect(charged.ok).toBe(true);
      expect(charged.free).toBe(true);
    }
    expect(ledger.forks.f1.spent).toEqual({ read: 0 });
  });

  test("a branch with no fork record has no budget either", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 2 });
    const charged = chargeBranch(s, ledger, {
      ownerId: "ghost",
      toolCallId: "c1",
      toolName: "read",
    });
    expect(charged.ok).toBe(false);
    expect(charged.code).toBe("NO_BRANCH_BUDGET");
  });

  test("a forked branch spends its own budget, not the parent's", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 2 });
    const charged = chargeBranch(s, ledger, {
      ownerId: "f1",
      toolCallId: "c1",
      toolName: "read",
      beatTools: ["read"],
    });
    expect(charged.ok).toBe(true);
    expect(charged.amount).toBe(1);
    expect(ledger.forks.f1.spent.read).toBe(1);
    expect(ledger.forks.f1.remaining.read).toBe(1);
  });

  test("a beat with three reads spends about one turn, not three", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 5 });
    const beat = ["read", "read", "read"];
    const amounts = beat.map((tool, index) => {
      const charged = chargeBranch(s, ledger, {
        ownerId: "f1",
        toolCallId: `beat#${index}`,
        toolName: tool,
        groupKey: "beat",
        beatTools: beat,
        input: { path: `f${index}.mjs` },
      });
      expect(charged.ok).toBe(true);
      return charged.amount;
    });
    // One assistant message spends exactly one turn however its calls divide;
    // the two-decimal split may leave a hundredth behind.
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    expect(total).toBeGreaterThan(0.96);
    expect(total).toBeLessThanOrEqual(1);
    expect(ledger.forks.f1.spent.read).toBeCloseTo(total, 2);
  });

  test("free control tools cost nothing", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 1 });
    const charged = chargeBranch(s, ledger, {
      ownerId: "f1",
      toolCallId: "c1",
      toolName: "scope_join",
    });
    expect(charged.ok).toBe(true);
    expect(ledger.forks.f1.remaining.read).toBe(1);
  });

  test("an exhausted branch runs the call and marks it panhandled", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 0 });
    const charged = chargeBranch(s, ledger, {
      ownerId: "f1",
      toolCallId: "c1",
      toolName: "read",
    });
    expect(charged.ok).toBe(true);
    expect(charged.panhandled).toBe(true);
    expect(charged.amount).toBe(0);
    expect(ledger.forks.f1.remaining.read).toBe(0);
    expect(ledger.forks.f1.panhandles.map((entry) => entry.tool)).toEqual(["read"]);
  });

});
