import { describe, expect, test } from "bun:test";
import {
  applyRegret,
  beginScope,
  beatShares,
  budgetText,
  chargeTool,
  closeScope,
  createState,
  currentScope,
  deferIntent,
  deserializeState,
  findActivePools,
  findFoldablePool,
  findElderSibling,
  findHotWorkbench,
  findPendingReportElder,
  markSubsumedDescendants,
  roundAmount,
  sealClosedParentChildren,
  serializeState,
  truncateForHostBoundary,
} from "../src/scope/index.mjs";

const STEER_HEADER =
  "You deferred the following findings in this scope. Address them now:";

function openScope(intent, budget, toolCallId = "call_begin") {
  const state = createState();
  const result = beginScope(state, { toolCallId, intent, budget });
  expect(result.ok).toBe(true);
  return { state, scope: result.scope };
}

describe("handoff boundaries", () => {
  test("records the relay generation on a new scope", () => {
    const state = createState();
    state.relay = { ...state.relay, generation: 1 };
    const result = beginScope(state, {
      toolCallId: "call_begin",
      intent: "work",
      budget: { read: 1 },
    });
    expect(result.ok).toBe(true);
    expect(result.scope.boundary).toBe(1);
  });

  test("finds elder siblings only within the same boundary", () => {
    const state = createState();
    state.collapses.push(
      {
        beginToolCallId: "call_old_begin",
        endToolCallId: "call_old_end",
        report: "old",
        parentId: null,
        order: 1,
        collapsed: false,
        createdAt: 1,
        boundary: 0,
      },
      {
        beginToolCallId: "call_new_begin",
        endToolCallId: "call_new_end",
        report: "new",
        parentId: null,
        order: 2,
        collapsed: false,
        createdAt: 2,
        boundary: 1,
      },
    );
    expect(findElderSibling(state, null, 3, 1)?.report).toBe("new");
    expect(findElderSibling(state, null, 3, 2)).toBeNull();
    expect(findElderSibling(state, null, 3, 0)?.report).toBe("old");
  });

  test("host truncation keeps the outermost scope and advances the epoch", () => {
    const state = createState();
    const outer = beginScope(state, {
      toolCallId: "call_outer",
      intent: "outer",
      budget: { read: 2 },
    });
    expect(outer.ok).toBe(true);
    chargeTool(state, {
      toolCallId: "outer_charge",
      toolName: "read",
      beatTools: ["read"],
    });
    const inner = beginScope(state, {
      toolCallId: "call_inner",
      intent: "inner",
      budget: { read: 2 },
    });
    expect(inner.ok).toBe(true);
    chargeTool(state, {
      toolCallId: "inner_charge",
      toolName: "read",
      beatTools: ["read"],
    });
    deferIntent(state, { toolCallId: "defer_inner", intent: "keep me" });

    expect(truncateForHostBoundary(state)).toBe(true);

    expect(state.epoch).toBe(1);
    expect(state.scopes.length).toBe(1);
    expect(state.scopes[0].id).toBe(outer.scope.id);
    expect(state.scopes[0].epoch).toBe(1);
    expect(state.charges.outer_charge).toBeDefined();
    expect(state.charges.inner_charge).toBeUndefined();
    expect(state.scopes[0].defers).toEqual([
      { toolCallId: "defer_inner", intent: "keep me" },
    ]);
  });

  test("elder siblings never match across a truncation epoch", () => {
    const state = createState();
    state.collapses.push({
      beginToolCallId: "call_old_begin",
      endToolCallId: "call_old_end",
      report: "old",
      parentId: null,
      order: 1,
      collapsed: false,
      createdAt: 1,
      boundary: 0,
      epoch: 0,
    });
    expect(findElderSibling(state, null, 2, 0, 0)?.report).toBe("old");
    expect(findElderSibling(state, null, 2, 0, 1)).toBeNull();
  });
});

describe("createState", () => {
  test("returns a fresh version 2 state with an empty relay", () => {
    expect(createState()).toEqual({
      version: 2,
      seq: 0,
      epoch: 0,
      scopes: [],
      charges: {},
      regrets: [],
      collapses: [],
      relay: {
        generation: 0,
        firstEvaluation: null,
        canStop: false,
        handoffPending: false,
        promotionInvalidated: false,
        handoffError: null,
        lastLedger: null,
        lastHandoff: null,
      },
    });
  });

  test("returns independent objects on every call", () => {
    const first = createState();
    const second = createState();
    first.scopes.push({ id: "scope-9" });
    first.regrets.push("beat");
    expect(second.scopes).toEqual([]);
    expect(second.regrets).toEqual([]);
  });
});

describe("beginScope", () => {
  test("pushes a scope and returns it", () => {
    const state = createState();
    const result = beginScope(state, {
      toolCallId: "call_begin",
      intent: "  Inspect the repo  ",
      budget: { read: 7, bash: 6 },
    });
    expect(result.ok).toBe(true);
    expect(result.scope).toEqual({
      id: "scope-1",
      boundary: 0,
      epoch: 0,
      intent: "Inspect the repo",
      beginToolCallId: "call_begin",
      budget: { read: 7, bash: 6 },
      remaining: { read: 7, bash: 6 },
      spent: { read: 0, bash: 0 },
      defers: [],
      residualDefers: [],
      baseInputTokens: null,
      preBeginInputTokens: null,
      endInputTokens: null,
      endInputTokensPending: false,
      beginResultChars: 0,
    });
    expect(currentScope(state)).toBe(result.scope);
    expect(state.seq).toBe(1);
  });

  test("copies the budget so later caller changes do not leak", () => {
    const state = createState();
    const budget = { bash: 2 };
    const result = beginScope(state, {
      toolCallId: "call_begin",
      intent: "work",
      budget,
    });
    budget.bash = 0;
    expect(result.scope.budget).toEqual({ bash: 2 });
    expect(result.scope.remaining).toEqual({ bash: 2 });
  });

  test("increments ids from the shared sequence", () => {
    const state = createState();
    const first = beginScope(state, {
      toolCallId: "call_1",
      intent: "first",
      budget: {},
    });
    const second = beginScope(state, {
      toolCallId: "call_2",
      intent: "second",
      budget: {},
    });
    expect(first.scope.id).toBe("scope-1");
    expect(second.scope.id).toBe("scope-2");
    expect(state.scopes).toHaveLength(2);
  });

  test("rejects a missing, empty, or non-string intent", () => {
    for (const intent of [undefined, "", "   ", null, 42]) {
      const state = createState();
      const result = beginScope(state, {
        toolCallId: "call_begin",
        intent,
        budget: {},
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("INVALID_INTENT");
      expect(typeof result.reason).toBe("string");
      expect(state.scopes).toEqual([]);
      expect(state.seq).toBe(0);
    }
  });

  test("rejects a malformed budget", () => {
    const budgets = [
      undefined,
      null,
      [],
      "bash",
      { bash: -1 },
      { bash: 1.5 },
      { bash: "2" },
      { bash: Number.NaN },
      { "   ": 1 },
    ];
    for (const budget of budgets) {
      const state = createState();
      const result = beginScope(state, {
        toolCallId: "call_begin",
        intent: "work",
        budget,
      });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("INVALID_BUDGET");
      expect(state.scopes).toEqual([]);
      expect(state.seq).toBe(0);
    }
  });
});

describe("chargeTool", () => {
  test("rejects a charge outside a scope", () => {
    const state = createState();
    const result = chargeTool(state, {
      toolCallId: "call_bash",
      toolName: "bash",
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_IN_SCOPE" });
    expect(state.charges).toEqual({});
  });

  test("charges only the innermost scope", () => {
    const { state, scope: outer } = openScope("outer", { bash: 2 });
    const inner = beginScope(state, {
      toolCallId: "call_inner_begin",
      intent: "inner",
      budget: { bash: 1 },
    }).scope;
    const charged = chargeTool(state, {
      toolCallId: "call_inner_charge",
      toolName: "bash",
    });
    expect(charged).toEqual({ ok: true, remaining: { bash: 0 } });
    expect(outer.remaining).toEqual({ bash: 2 });
    expect(outer.spent).toEqual({ bash: 0 });
    const blocked = chargeTool(state, {
      toolCallId: "call_inner_charge_2",
      toolName: "bash",
    });
    expect(blocked.code).toBe("BUDGET_EXHAUSTED");
  });

  test("blocks a tool without a budget key", () => {
    const { state, scope } = openScope("work", { bash: 1 });
    const result = chargeTool(state, {
      toolCallId: "call_write",
      toolName: "write",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("BUDGET_EXHAUSTED");
    expect(result.reason).toContain("write");
    expect(result.reason).toContain("0.00/0.00");
    expect(scope.spent).toEqual({ bash: 0 });
    expect(state.charges).toEqual({});
  });

  test("blocks a zero budget", () => {
    const { state, scope } = openScope("work", { bash: 0 });
    const result = chargeTool(state, {
      toolCallId: "call_bash",
      toolName: "bash",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("BUDGET_EXHAUSTED");
    expect(result.reason).toContain("bash");
    expect(result.reason).toContain("0.00/0.00");
    expect(scope.spent).toEqual({ bash: 0 });
    expect(state.charges).toEqual({});
  });

  test("is idempotent for the same tool call id", () => {
    const { state, scope } = openScope("work", { bash: 2 });
    const first = chargeTool(state, {
      toolCallId: "call_bash",
      toolName: "bash",
    });
    const second = chargeTool(state, {
      toolCallId: "call_bash",
      toolName: "bash",
    });
    expect(first).toEqual({ ok: true, remaining: { bash: 1 } });
    expect(second).toEqual({ ok: true, remaining: { bash: 1 } });
    expect(scope.remaining).toEqual({ bash: 1 });
    expect(scope.spent).toEqual({ bash: 1 });
    expect(Object.keys(state.charges)).toEqual(["call_bash"]);
    expect(state.charges.call_bash).toEqual({
      scopeId: scope.id,
      tool: "bash",
      amount: 1,
    });
  });

  test("never charges control tools", () => {
    const { state, scope } = openScope("work", { bash: 1 });
    for (const [index, toolName] of ["scope", "regret", "defer", "pin"].entries()) {
      const result = chargeTool(state, {
        toolCallId: `call_free_${index}`,
        toolName,
      });
      expect(result).toEqual({ ok: true, remaining: { bash: 1 } });
    }
    expect(scope.spent).toEqual({ bash: 0 });
    expect(state.charges).toEqual({});
  });

  test("charges one unit for a same-tool batch", () => {
    const { state, scope } = openScope("batch", { bash: 2 });
    const first = chargeTool(state, {
      toolCallId: "call_a",
      toolName: "bash",
      groupKey: "beat-1",
      beatTools: ["bash", "bash"],
    });
    const second = chargeTool(state, {
      toolCallId: "call_b",
      toolName: "bash",
      groupKey: "beat-1",
      beatTools: ["bash", "bash"],
    });
    expect(first).toEqual({ ok: true, remaining: { bash: 1 } });
    expect(second).toEqual({ ok: true, remaining: { bash: 1 } });
    expect(scope.spent).toEqual({ bash: 1 });
    expect(scope.remaining).toEqual({ bash: 1 });
    expect(Object.keys(state.charges)).toEqual(["call_a"]);
    expect(state.charges.call_a.groupKey).toBe("beat-1");
  });

  test("splits one unit across different tools in one batch", () => {
    const { state, scope } = openScope("batch", { bash: 1, read: 1 });
    const beatTools = ["bash", "bash", "bash", "read", "read"];
    const bash = chargeTool(state, {
      toolCallId: "call_bash",
      toolName: "bash",
      groupKey: "beat-1",
      beatTools,
    });
    const read = chargeTool(state, {
      toolCallId: "call_read",
      toolName: "read",
      groupKey: "beat-1",
      beatTools,
    });
    expect(bash).toEqual({ ok: true, remaining: { bash: 0.4, read: 1 } });
    expect(read).toEqual({ ok: true, remaining: { bash: 0.4, read: 0.6 } });
    expect(scope.spent).toEqual({ bash: 0.6, read: 0.4 });
    expect(scope.remaining).toEqual({ bash: 0.4, read: 0.6 });
  });

  test("blocks only the exhausted tool and keeps the rest of the beat running", () => {
    const { state, scope } = openScope("partial", { bash: 1, read: 1 });
    chargeTool(state, {
      toolCallId: "call_r1",
      toolName: "read",
      groupKey: "beat-1",
      beatTools: ["read"],
    });
    const beatTools = ["read", "bash"];
    const blocked = chargeTool(state, {
      toolCallId: "call_r2",
      toolName: "read",
      groupKey: "beat-2",
      beatTools,
    });
    expect(blocked.code).toBe("BUDGET_EXHAUSTED");
    expect(blocked.reason).toContain("0.00/1.00");
    const bash = chargeTool(state, {
      toolCallId: "call_b1",
      toolName: "bash",
      groupKey: "beat-2",
      beatTools,
    });
    expect(bash.ok).toBe(true);
    expect(scope.remaining).toEqual({ bash: 0.5, read: 0 });
    expect(scope.spent).toEqual({ bash: 0.5, read: 1 });
  });
});

describe("beatShares", () => {
  test("splits one unit by call count with two decimals", () => {
    expect(beatShares(["bash", "bash", "bash", "read", "read"])).toEqual({
      bash: 0.6,
      read: 0.4,
    });
  });

  test("hands the rounding residue to the most frequent tool", () => {
    const shares = beatShares(["bash", "read", "grep"]);
    expect(shares).toEqual({ bash: 0.34, read: 0.33, grep: 0.33 });
    const total = Object.values(shares).reduce((sum, amount) => sum + amount, 0);
    expect(roundAmount(total)).toBe(1);
  });

  test("ignores free tools and normalizes apply_patch", () => {
    expect(
      beatShares(["scope", "defer", "pin", "todo", "apply_patch"]),
    ).toEqual({ edit: 1 });
    expect(beatShares([])).toEqual({});
  });
});

describe("deferIntent", () => {
  test("rejects a defer outside a scope", () => {
    const state = createState();
    const result = deferIntent(state, {
      toolCallId: "call_defer",
      intent: "Check logs",
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_IN_SCOPE" });
  });

  test("rejects a missing or empty intent", () => {
    const { state } = openScope("work", {});
    for (const intent of [undefined, "", "   ", null]) {
      const result = deferIntent(state, {
        toolCallId: "call_defer",
        intent,
      });
      expect(result).toMatchObject({ ok: false, code: "INVALID_INTENT" });
    }
    expect(currentScope(state).defers).toEqual([]);
  });

  test("records a trimmed defer without charging", () => {
    const { state, scope } = openScope("work", { bash: 1 });
    const result = deferIntent(state, {
      toolCallId: "call_defer",
      intent: "  Check logs  ",
    });
    expect(result).toEqual({ ok: true });
    expect(scope.defers).toEqual([
      { toolCallId: "call_defer", intent: "Check logs" },
    ]);
    expect(scope.remaining).toEqual({ bash: 1 });
    expect(scope.spent).toEqual({ bash: 0 });
    expect(state.charges).toEqual({});
  });
});

describe("applyRegret", () => {
  test("refunds the matching charges and records the beat", () => {
    const { state, scope } = openScope("repair", { bash: 3, read: 1 });
    chargeTool(state, { toolCallId: "call_a", toolName: "bash" });
    chargeTool(state, { toolCallId: "call_b", toolName: "read" });
    const result = applyRegret(state, {
      scopeId: scope.id,
      beat: { key: "tc:call_a,call_b", toolCallIds: ["call_a", "call_b"] },
      toolCalls: [
        { id: "call_a", name: "bash", arguments: {} },
        { id: "call_b", name: "read", arguments: {} },
      ],
    });
    expect(result).toEqual({
      ok: true,
      refunded: 2,
      residualDefers: [],
      remaining: { bash: 3, read: 1 },
    });
    expect(scope.spent).toEqual({ bash: 0, read: 0 });
    expect(state.charges).toEqual({});
    expect(state.regrets).toEqual(["tc:call_a,call_b"]);
  });

  test("counts only the calls that had a charge", () => {
    const { state, scope } = openScope("repair", { bash: 2 });
    chargeTool(state, { toolCallId: "call_a", toolName: "bash" });
    const result = applyRegret(state, {
      scopeId: scope.id,
      beat: { key: "tc:call_a,call_missing", toolCallIds: ["call_a", "call_missing"] },
      toolCalls: [
        { id: "call_a", name: "bash", arguments: {} },
        { id: "call_missing", name: "bash", arguments: {} },
      ],
    });
    expect(result.refunded).toBe(1);
    expect(result.remaining).toEqual({ bash: 2 });
    expect(state.charges.call_missing).toBeUndefined();
  });

  test("does not refund charges from another scope", () => {
    const { state, scope: outer } = openScope("outer", { bash: 2 });
    chargeTool(state, { toolCallId: "call_outer_charge", toolName: "bash" });
    const inner = beginScope(state, {
      toolCallId: "call_inner_begin",
      intent: "inner",
      budget: { bash: 2 },
    }).scope;
    chargeTool(state, { toolCallId: "call_inner_charge", toolName: "bash" });
    const result = applyRegret(state, {
      scopeId: inner.id,
      beat: {
        key: "tc:call_outer_charge,call_inner_charge",
        toolCallIds: ["call_outer_charge", "call_inner_charge"],
      },
      toolCalls: [
        { id: "call_outer_charge", name: "bash", arguments: {} },
        { id: "call_inner_charge", name: "bash", arguments: {} },
      ],
    });
    expect(result.refunded).toBe(1);
    expect(inner.remaining).toEqual({ bash: 2 });
    expect(outer.remaining).toEqual({ bash: 1 });
    expect(outer.spent).toEqual({ bash: 1 });
    expect(state.charges.call_outer_charge).toBeDefined();
    expect(state.charges.call_inner_charge).toBeUndefined();
  });

  test("withdraws a defer and keeps it as a residual defer", () => {
    const { state, scope } = openScope("triage", { bash: 1 });
    deferIntent(state, { toolCallId: "call_d1", intent: "Check A" });
    deferIntent(state, { toolCallId: "call_d2", intent: "Check B" });
    const result = applyRegret(state, {
      scopeId: scope.id,
      beat: { key: "tc:call_d1", toolCallIds: ["call_d1"] },
      toolCalls: [
        { id: "call_d1", name: "defer", arguments: { intent: "Check A" } },
      ],
    });
    expect(scope.defers).toEqual([
      { toolCallId: "call_d2", intent: "Check B" },
    ]);
    expect(scope.residualDefers).toEqual([
      { toolCallId: "call_d1", intent: "Check A" },
    ]);
    expect(result.residualDefers).toEqual([
      { toolCallId: "call_d1", intent: "Check A" },
    ]);
    expect(result.refunded).toBe(0);
    expect(result.remaining).toEqual({ bash: 1 });
    applyRegret(state, {
      scopeId: scope.id,
      beat: { key: "tc:call_d1_again", toolCallIds: ["call_d1"] },
      toolCalls: [{ id: "call_d1", name: "defer", arguments: {} }],
    });
    expect(scope.residualDefers).toHaveLength(1);
  });

  test("records a beat even without charges", () => {
    const { state, scope } = openScope("think", {});
    const result = applyRegret(state, {
      scopeId: scope.id,
      beat: { key: "msg:1700000000000:abc123", toolCallIds: [] },
      toolCalls: [],
    });
    expect(result).toEqual({
      ok: true,
      refunded: 0,
      residualDefers: [],
      remaining: {},
    });
    expect(state.regrets).toEqual(["msg:1700000000000:abc123"]);
  });

  test("rejects a closed scope", () => {
    const { state, scope } = openScope("work", {});
    closeScope(state, { toolCallId: "call_end", report: "done" });
    const result = applyRegret(state, {
      scopeId: scope.id,
      beat: { key: "tc:x", toolCallIds: [] },
      toolCalls: [],
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_IN_SCOPE" });
    expect(state.regrets).toEqual([]);
  });

  test("rejects a missing beat key", () => {
    const { state, scope } = openScope("work", {});
    const result = applyRegret(state, {
      scopeId: scope.id,
      beat: {},
      toolCalls: [],
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_BEAT" });
  });
});

describe("closeScope", () => {
  test("rejects a close outside a scope", () => {
    const state = createState();
    const result = closeScope(state, {
      toolCallId: "call_end",
      report: "done",
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_IN_SCOPE" });
    expect(state.scopes).toEqual([]);
  });

  test("closes without a report; archiving is deferred to the next sibling", () => {
    const { state } = openScope("work", {});
    const result = closeScope(state, { toolCallId: "call_end" });
    expect(result.ok).toBe(true);
    expect(currentScope(state)).toBeNull();
  });

  test("pops the innermost scope and removes only its charges", () => {
    const { state, scope: outer } = openScope("outer", { bash: 2 });
    chargeTool(state, {
      toolCallId: "call_outer_charge",
      toolName: "bash",
    });
    const inner = beginScope(state, {
      toolCallId: "call_inner_begin",
      intent: "inner",
      budget: { read: 1 },
    }).scope;
    chargeTool(state, {
      toolCallId: "call_inner_charge",
      toolName: "read",
    });
    const result = closeScope(state, {
      toolCallId: "call_end",
      report: "inner done",
    });
    expect(result.ok).toBe(true);
    expect(result.scope).toBe(inner);
    expect(state.scopes).toEqual([outer]);
    expect(currentScope(state)).toBe(outer);
    expect(state.charges).toEqual({
      call_outer_charge: {
        scopeId: outer.id,
        tool: "bash",
        amount: 1,
      },
    });
    expect(result.defers).toEqual([]);
    expect(result.steerText).toBe("");
  });

  test("delivers active and residual defers once each", () => {
    const { state, scope } = openScope("triage", {});
    deferIntent(state, { toolCallId: "call_d1", intent: "Check A" });
    deferIntent(state, { toolCallId: "call_d2", intent: "Check B" });
    deferIntent(state, { toolCallId: "call_d3", intent: "  Check B  " });
    applyRegret(state, {
      scopeId: scope.id,
      beat: { key: "tc:call_d1", toolCallIds: ["call_d1"] },
      toolCalls: [{ id: "call_d1", name: "defer", arguments: {} }],
    });
    const result = closeScope(state, {
      toolCallId: "call_end",
      report: "done",
    });
    expect(result.defers).toEqual([
      { toolCallId: "call_d2", intent: "Check B" },
      { toolCallId: "call_d1", intent: "Check A" },
    ]);
    expect(result.steerText).toBe(
      `${STEER_HEADER}\n- Check B\n- Check A`,
    );
  });

  test("keeps the outer scope open after an inner close", () => {
    const { state, scope: outer } = openScope("outer", { bash: 1 });
    beginScope(state, {
      toolCallId: "call_inner_begin",
      intent: "inner",
      budget: {},
    });
    closeScope(state, { toolCallId: "call_inner_end", report: "inner done" });
    expect(currentScope(state)).toBe(outer);
    const charged = chargeTool(state, {
      toolCallId: "call_outer_charge",
      toolName: "bash",
    });
    expect(charged).toEqual({ ok: true, remaining: { bash: 0 } });
  });
});

describe("budgetText", () => {
  test("reports remaining/budget sorted by tool name", () => {
    const { state, scope } = openScope("work", { read: 7, bash: 6 });
    expect(budgetText(scope)).toBe("bash 6.00/6.00, read 7.00/7.00");
    chargeTool(state, { toolCallId: "call_bash", toolName: "bash" });
    expect(budgetText(scope)).toBe("bash 5.00/6.00, read 7.00/7.00");
  });

  test("shows fractional shares with two decimals", () => {
    const { state, scope } = openScope("work", { bash: 1, read: 1 });
    const beatTools = ["bash", "read", "read"];
    chargeTool(state, {
      toolCallId: "call_bash",
      toolName: "bash",
      groupKey: "beat-1",
      beatTools,
    });
    chargeTool(state, {
      toolCallId: "call_read",
      toolName: "read",
      groupKey: "beat-1",
      beatTools,
    });
    expect(budgetText(scope)).toBe("bash 0.67/1.00, read 0.33/1.00");
  });

  test("returns an empty string when there is no budget", () => {
    expect(budgetText(openScope("work", {}).scope)).toBe("");
    expect(budgetText(null)).toBe("");
    expect(budgetText({})).toBe("");
  });
});

describe("serializeState and deserializeState", () => {
  test("round-trips through JSON", () => {
    const state = createState();
    const outer = beginScope(state, {
      toolCallId: "call_outer_begin",
      intent: "outer",
      budget: { bash: 2 },
    }).scope;
    chargeTool(state, {
      toolCallId: "call_outer_charge",
      toolName: "bash",
    });
    deferIntent(state, {
      toolCallId: "call_outer_defer",
      intent: "Check logs",
    });
    applyRegret(state, {
      scopeId: outer.id,
      beat: {
        key: "tc:call_outer_charge",
        toolCallIds: ["call_outer_charge"],
      },
      toolCalls: [
        { id: "call_outer_charge", name: "bash", arguments: {} },
      ],
    });
    beginScope(state, {
      toolCallId: "call_inner_begin",
      intent: "inner",
      budget: { read: 1 },
    });
    chargeTool(state, {
      toolCallId: "call_inner_charge",
      toolName: "read",
    });
    deferIntent(state, {
      toolCallId: "call_inner_defer",
      intent: "Check tests",
    });
    state.collapses.push({
      beginToolCallId: "call_old_begin",
      endToolCallId: "call_old_end",
      report: "old report",
      parentId: null,
      order: 0,
      collapsed: true,
      createdAt: 1700000000000,
      boundary: 0,
      epoch: 0,
    });

    const payload = serializeState(state);
    expect(payload).not.toBe(state);
    const restored = deserializeState(JSON.parse(JSON.stringify(payload)));
    expect(restored).toEqual(payload);
    expect(restored).toEqual(state);
    expect(deserializeState(JSON.stringify(payload))).toEqual(payload);
  });

  test("serializes detached copies", () => {
    const { state, scope } = openScope("work", { bash: 1 });
    deferIntent(state, { toolCallId: "call_defer", intent: "Check A" });
    const payload = serializeState(state);
    payload.scopes[0].remaining.bash = 0;
    payload.scopes[0].defers.push({ toolCallId: "x", intent: "y" });
    payload.charges.extra = { scopeId: "x", tool: "bash", amount: 1 };
    payload.regrets.push("beat");
    expect(scope.remaining).toEqual({ bash: 1 });
    expect(scope.defers).toEqual([
      { toolCallId: "call_defer", intent: "Check A" },
    ]);
    expect(state.charges).toEqual({});
    expect(state.regrets).toEqual([]);
  });

  test("round-trips a state without call ids", () => {
    const state = createState();
    beginScope(state, { intent: "work", budget: { bash: 1 } });
    deferIntent(state, { intent: "Check A" });
    const payload = serializeState(state);
    expect(payload.scopes[0].beginToolCallId).toBe("");
    expect(payload.scopes[0].defers[0].toolCallId).toBe("");
    expect(deserializeState(JSON.parse(JSON.stringify(payload)))).toEqual(
      payload,
    );
  });

  test("ignores unknown fields", () => {
    const { state } = openScope("work", { bash: 1 });
    const payload = serializeState(state);
    const dirty = {
      ...payload,
      unknown: true,
      scopes: payload.scopes.map((scope) => ({ ...scope, unknown: true })),
    };
    const restored = deserializeState(dirty);
    expect(restored).toEqual(payload);
    expect(restored.unknown).toBeUndefined();
    expect(restored.scopes[0].unknown).toBeUndefined();
  });

  test("returns a fresh state for malformed input", () => {
    const state = createState();
    const payload = serializeState(state);
    const corrupt = [
      undefined,
      null,
      0,
      "not json",
      "{}",
      [],
      { version: 2 },
      { ...payload, version: 1, seq: -1 },
      { ...payload, version: 1, scopes: "nope" },
      { ...payload, version: 1, scopes: [{}] },
      { ...payload, version: 1, charges: null },
      { ...payload, version: 1, regrets: [42] },
      { ...payload, version: 1, collapses: [{}] },
    ];
    for (const input of corrupt) {
      expect(deserializeState(input)).toEqual(createState());
    }
  });

  test("returns a fresh state for a corrupt scope or charge", () => {
    const { state } = openScope("work", { bash: 1 });
    chargeTool(state, { toolCallId: "call_bash", toolName: "bash" });

    const badRemaining = serializeState(state);
    badRemaining.scopes[0].remaining.bash = -1;
    expect(deserializeState(badRemaining)).toEqual(createState());

    const badCharge = serializeState(state);
    badCharge.charges.call_bash.amount = 0;
    expect(deserializeState(badCharge)).toEqual(createState());
  });

  test("migrates a version 1 state to version 2 with a fresh relay", () => {
    const legacy = {
      version: 1,
      seq: 0,
      scopes: [],
      charges: {},
      regrets: [],
      collapses: [],
    };
    const migrated = deserializeState(legacy);
    expect(migrated.version).toBe(2);
    expect(migrated.relay).toEqual(createState().relay);
    expect(migrated).toEqual(createState());
  });
});

function makeCollapse(overrides = {}) {
  return {
    beginToolCallId: "call_begin",
    endToolCallId: "call_end",
    report: "report",
    parentId: null,
    order: 1,
    collapsed: false,
    createdAt: 1700000000000,
    boundary: 0,
    epoch: 0,
    scopeId: "scope-1",
    intent: "work",
    sealed: false,
    ...overrides,
  };
}

describe("elder lifecycle queries", () => {
  test("finds the single unarchived elder at a level", () => {
    const state = createState();
    state.collapses.push(
      makeCollapse({ report: null, scopeId: "s1", order: 1, beginToolCallId: "b1", endToolCallId: "e1" }),
      makeCollapse({ report: "done", scopeId: "s2", order: 2 }),
    );
    expect(findPendingReportElder(state, null, 0, 0)?.scopeId).toBe("s1");
    expect(findPendingReportElder(state, "no-parent", 0, 0)).toBeNull();
  });

  test("a sealed pending elder is no longer pending", () => {
    const state = createState();
    state.collapses.push(
      makeCollapse({ report: null, scopeId: "s1", sealed: true }),
    );
    expect(findPendingReportElder(state, null, 0, 0)).toBeNull();
  });

  test("findHotWorkbench returns the highest uncollapsed order", () => {
    const state = createState();
    state.collapses.push(
      makeCollapse({ scopeId: "s1", order: 1 }),
      makeCollapse({ scopeId: "s2", order: 3 }),
      makeCollapse({ scopeId: "s3", order: 5, collapsed: true }),
    );
    expect(findHotWorkbench(state, null, 0, 0)?.scopeId).toBe("s2");
  });

  test("findFoldablePool keeps archived elders strictly behind the workbench", () => {
    const state = createState();
    state.collapses.push(
      makeCollapse({ scopeId: "s1", report: "r1", order: 1 }),
      makeCollapse({ scopeId: "s2", report: "r2", order: 2 }),
      makeCollapse({ scopeId: "s3", report: null, order: 3 }),
      makeCollapse({ scopeId: "s0", report: "sealed", order: 0, sealed: true }),
    );
    expect(findFoldablePool(state, null, 0, 0).map((r) => r.scopeId)).toEqual([
      "s1",
      "s2",
    ]);
  });

  test("findActivePools skips levels whose parent is no longer on the stack", () => {
    const state = createState();
    state.scopes.push({ id: "parent-1" });
    state.collapses.push(
      makeCollapse({ parentId: null, report: "r1", scopeId: "s1", order: 1 }),
      makeCollapse({ parentId: null, report: "r2", scopeId: "s2", order: 2, beginToolCallId: "b2" }),
      makeCollapse({ parentId: "parent-1", report: "r3", scopeId: "s3", order: 3, beginToolCallId: "b3" }),
      makeCollapse({ parentId: "parent-1", report: "r4", scopeId: "s4", order: 4, beginToolCallId: "b4" }),
      makeCollapse({ parentId: "ghost", report: "r5", scopeId: "s5", order: 5, beginToolCallId: "b5" }),
    );
    const groups = findActivePools(state);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.parentId).sort()).toEqual([null, "parent-1"].sort());
    for (const group of groups) expect(group.pool).toHaveLength(1);
  });

  test("markSubsumedDescendants folds descendants transitively", () => {
    const state = createState();
    state.collapses.push(
      makeCollapse({ scopeId: "root", parentId: null, report: "r", order: 1, collapsed: true }),
      makeCollapse({ scopeId: "child", parentId: "root", report: null, order: 2 }),
      makeCollapse({ scopeId: "grand", parentId: "child", report: null, order: 3 }),
    );
    expect(markSubsumedDescendants(state, [{ scopeId: "root" }])).toBe(2);
    expect(state.collapses[1].collapsed).toBe(true);
    expect(state.collapses[2].collapsed).toBe(true);
  });

  test("sealClosedParentChildren seals only pending children of the parent", () => {
    const state = createState();
    state.collapses.push(
      makeCollapse({ parentId: "parent-x", report: null, scopeId: "s1" }),
      makeCollapse({ parentId: "parent-x", report: "done", scopeId: "s2" }),
      makeCollapse({ parentId: "other", report: null, scopeId: "s3" }),
    );
    expect(sealClosedParentChildren(state, "parent-x")).toBe(1);
    expect(state.collapses[0].sealed).toBe(true);
    expect(state.collapses[2].sealed).toBe(false);
  });

  test("host boundary seals a stale pending elder and collapses stale archives", () => {
    const state = createState();
    state.collapses.push(
      makeCollapse({ report: null, epoch: 0, order: 1, scopeId: "s1", beginToolCallId: "b1", endToolCallId: "e1" }),
      makeCollapse({ report: "done", epoch: 0, order: 2, scopeId: "s2" }),
    );
    expect(truncateForHostBoundary(state)).toBe(true);
    expect(state.epoch).toBe(1);
    expect(state.collapses[0].sealed).toBe(true);
    expect(state.collapses[0].collapsed).toBe(false);
    expect(state.collapses[1].collapsed).toBe(true);
  });
});

describe("measured collapse persistence", () => {
  test("round-trips null reports and measured fields", () => {
    const state = createState();
    state.collapses.push({
      ...makeCollapse({ report: null, scopeId: "s1", sealed: false }),
      paidRentCost: 1.25,
      interiorTokens: 320,
      interiorChars: 900,
      pinTokens: 12,
      baseInputTokens: 4000,
      endInputTokens: null,
      endInputTokensPending: true,
    });
    const restored = deserializeState(JSON.stringify(serializeState(state)));
    expect(restored.collapses[0]).toMatchObject({
      report: null,
      sealed: false,
      paidRentCost: 1.25,
      interiorTokens: 320,
      pinTokens: 12,
      baseInputTokens: 4000,
      endInputTokensPending: true,
    });
  });

  test("legacy snapshots without measured fields still deserialize", () => {
    const legacy = {
      version: 2,
      seq: 1,
      epoch: 0,
      scopes: [],
      charges: {},
      regrets: [],
      collapses: [
        {
          beginToolCallId: "b",
          endToolCallId: "e",
          report: "done",
          parentId: null,
          order: 0,
          collapsed: true,
          createdAt: 1,
          boundary: 0,
          epoch: 0,
        },
      ],
      relay: createState().relay,
    };
    const restored = deserializeState(legacy);
    expect(restored.collapses[0].report).toBe("done");
    expect(restored.collapses[0].sealed).toBeUndefined();
    expect(restored.collapses[0].paidRentCost).toBeUndefined();
  });

  test("a pending null report that is collapsed fails validation", () => {
    const state = createState();
    state.collapses.push(makeCollapse({ report: null, collapsed: true }));
    expect(deserializeState(serializeState(state))).toEqual(createState());
  });
});
