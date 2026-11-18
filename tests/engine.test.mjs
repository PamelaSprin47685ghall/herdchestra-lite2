import { describe, expect, test } from "bun:test";
import {
  applyRegret,
  beginScope,
  budgetText,
  chargeTool,
  closeScope,
  createState,
  currentScope,
  deferIntent,
  deserializeState,
  serializeState,
} from "../src/engine.mjs";

const STEER_HEADER =
  "You deferred the following findings in this scope. Address them now:";

function openScope(intent, budget, toolCallId = "call_begin") {
  const state = createState();
  const result = beginScope(state, { toolCallId, intent, budget });
  expect(result.ok).toBe(true);
  return { state, scope: result.scope };
}

describe("createState", () => {
  test("returns a fresh version 1 state", () => {
    expect(createState()).toEqual({
      version: 1,
      seq: 0,
      scopes: [],
      charges: {},
      regrets: [],
      collapses: [],
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
      intent: "Inspect the repo",
      beginToolCallId: "call_begin",
      budget: { read: 7, bash: 6 },
      remaining: { read: 7, bash: 6 },
      spent: { read: 0, bash: 0 },
      defers: [],
      residualDefers: [],
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
    expect(result.reason).toContain("0/0");
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
    expect(result.reason).toContain("0/0");
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
    for (const [index, toolName] of ["scope", "regret", "defer"].entries()) {
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
    });
    const second = chargeTool(state, {
      toolCallId: "call_b",
      toolName: "bash",
      groupKey: "beat-1",
    });
    expect(first).toEqual({ ok: true, remaining: { bash: 1 } });
    expect(second).toEqual({ ok: true, remaining: { bash: 1 } });
    expect(scope.spent).toEqual({ bash: 1 });
    expect(scope.remaining).toEqual({ bash: 1 });
    expect(Object.keys(state.charges)).toEqual(["call_a"]);
    expect(state.charges.call_a.groupKey).toBe("beat-1");
  });

  test("charges different tools in one batch separately", () => {
    const { state, scope } = openScope("batch", { bash: 1, read: 1 });
    chargeTool(state, {
      toolCallId: "call_bash",
      toolName: "bash",
      groupKey: "beat-1",
    });
    chargeTool(state, {
      toolCallId: "call_read",
      toolName: "read",
      groupKey: "beat-1",
    });
    expect(scope.spent).toEqual({ bash: 1, read: 1 });
    expect(scope.remaining).toEqual({ bash: 0, read: 0 });
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

  test("rejects a missing or empty report", () => {
    const { state } = openScope("work", {});
    for (const report of [undefined, "", "   ", null, 42]) {
      const result = closeScope(state, {
        toolCallId: "call_end",
        report,
      });
      expect(result).toMatchObject({ ok: false, code: "INVALID_REPORT" });
    }
    expect(state.scopes).toHaveLength(1);
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
    expect(budgetText(scope)).toBe("bash 6/6, read 7/7");
    chargeTool(state, { toolCallId: "call_bash", toolName: "bash" });
    expect(budgetText(scope)).toBe("bash 5/6, read 7/7");
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
});
