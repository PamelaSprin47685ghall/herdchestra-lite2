import { describe, expect, test } from "bun:test";

import { chargeBranch, refundBranch } from "../src/scope/accounting.mjs";
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
    intent: "task",
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
    expect(s.charges).toEqual({});
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
    expect(s.charges).toEqual({});
  });

  test("the root still runs free control tools and free protocol reads", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 2 });
    for (const [toolName, input] of [
      ["pin", { finding: "kept" }],
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
    expect(s.charges).toEqual({});
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
    expect(s.charges.c1).toEqual({ ownerId: "f1", tool: "read", amount: 1 });
    expect(ledger.forks.f1.remaining.read).toBe(1);
  });

  test("a repeated tool call is charged once", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 2 });
    chargeBranch(s, ledger, { ownerId: "f1", toolCallId: "c1", toolName: "read" });
    const again = chargeBranch(s, ledger, {
      ownerId: "f1",
      toolCallId: "c1",
      toolName: "read",
    });
    expect(again.ok).toBe(true);
    expect(again.alreadyCharged).toBe(true);
    expect(ledger.forks.f1.remaining.read).toBe(1);
  });

  test("free control tools cost nothing", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 1 });
    const charged = chargeBranch(s, ledger, {
      ownerId: "f1",
      toolCallId: "c1",
      toolName: "pin",
    });
    expect(charged.ok).toBe(true);
    expect(ledger.forks.f1.remaining.read).toBe(1);
  });

  test("an exhausted branch refuses the call with its balance", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 0 });
    const refused = chargeBranch(s, ledger, {
      ownerId: "f1",
      toolCallId: "c1",
      toolName: "read",
    });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("BUDGET_EXHAUSTED");
    expect(s.charges).toEqual({});
  });

  test("an amended beat returns exactly what its calls spent", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 2 });
    chargeBranch(s, ledger, { ownerId: "f1", toolCallId: "c1", toolName: "read" });
    chargeBranch(s, ledger, { ownerId: "f1", toolCallId: "c2", toolName: "read" });
    const refunded = refundBranch(s, ledger, {
      ownerId: "f1",
      toolCalls: [{ id: "c1" }, { id: "c2" }],
    });
    expect(refunded.ok).toBe(true);
    expect(refunded.refunded).toBe(2);
    expect(ledger.forks.f1.remaining.read).toBe(2);
    expect(s.charges).toEqual({});
  });

  test("a refund from another branch never touches this balance", () => {
    const s = state();
    const ledger = ledgerWith("f1", { read: 2 });
    chargeBranch(s, ledger, { ownerId: "f1", toolCallId: "c1", toolName: "read" });
    const refunded = refundBranch(s, ledger, {
      ownerId: "other",
      toolCalls: [{ id: "c1" }],
    });
    expect(refunded.refunded).toBe(0);
    expect(ledger.forks.f1.remaining.read).toBe(1);
    expect(s.charges.c1).toBeTruthy();
  });
});
