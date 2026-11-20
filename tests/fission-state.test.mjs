import { describe, expect, test } from "bun:test";
import {
  beginScope,
  chargeTool,
  createFlowState,
  createState,
  currentScope,
  splitFissionBudget,
  validateFission,
} from "../src/scope/index.mjs";

function batch(fission, stage = "architecture-design") {
  return { stage, elder_report: null, fission };
}

function flow(intent, budget, permission = "ro") {
  return { intent, budget, permission };
}

function open(state, budget) {
  const result = beginScope(state, {
    intent: "parent",
    stage: "architecture-design",
    budget,
  });
  expect(result.ok).toBe(true);
  return result.scope;
}

describe("fission state", () => {
  test("shares session fields even when a flow replaces them", () => {
    const base = createState();
    const first = createFlowState(base);
    const second = createFlowState(base);
    first.herdMode = true;
    first.relay = { ...first.relay, generation: 7 };
    first.stageFlags = { ...first.stageFlags, example: true };
    first.pins = [{ intent: "shared" }];
    expect(second.herdMode).toBe(true);
    expect(second.relay).toBe(base.relay);
    expect(second.relay.generation).toBe(7);
    expect(second.stageFlags).toBe(base.stageFlags);
    expect(second.pins).toBe(base.pins);
    second.pins.push({ intent: "also shared" });
    expect(first.pins).toHaveLength(2);
  });

  test("isolates scopes, charges, caches, amendments and pin views", () => {
    const base = createState();
    open(base, { read: 3 });
    base.pinSeen = new Set(["existing"]);
    const first = createFlowState(base);
    const second = createFlowState(base);
    chargeTool(first, { toolCallId: "first", toolName: "read" });
    first.modelCaches.model = { cachedUntilPos: 3 };
    first.amends.push("beat");
    first.pinSeen.add("first-only");
    expect(currentScope(first).remaining.read).toBe(2);
    expect(currentScope(second).remaining.read).toBe(3);
    expect(currentScope(base).remaining.read).toBe(3);
    expect(second.charges).toEqual({});
    expect(second.modelCaches).toEqual({});
    expect(second.amends).toEqual([]);
    expect(second.pinSeen.has("first-only")).toBe(false);
    expect(base.pinSeen.has("first-only")).toBe(false);
  });

  test("reserves normalized budgets once and leaves flow spending independent", () => {
    const state = createState();
    const parent = open(state, { read: 5, edit: 4 });
    const result = splitFissionBudget(state, batch([
      flow("one", { read: 2, apply_patch: 1 }),
      flow("two", { read: 1, edit: 2 }),
    ]));
    expect(result.ok).toBe(true);
    expect(result.totals).toEqual({ read: 3, edit: 3 });
    expect(parent.remaining).toEqual({ read: 2, edit: 1 });
    expect(parent.spent).toEqual({ read: 3, edit: 3 });
    const first = createFlowState(state);
    const second = createFlowState(state);
    open(first, result.items[0].budget);
    open(second, result.items[1].budget);
    chargeTool(first, { toolCallId: "first", toolName: "read" });
    expect(currentScope(first).remaining.read).toBe(1);
    expect(currentScope(second).remaining.read).toBe(1);
    expect(parent.remaining.read).toBe(2);
  });

  test("rejects the entire batch without changing state", () => {
    const invalid = [
      { stage: "architecture-design", elder_report: null, fission: [] },
      batch([flow("valid", { read: 1 }), flow("bad", { read: -1 })]),
      batch([flow("valid", { read: 1 }), flow("bad", { read: 3 })]),
      batch([flow("valid", { read: 1 }), flow("bad", {}, "invalid")]),
      batch([flow("valid", { read: 1 }), flow("bad", {}, "rw")], "decision-framing"),
      batch([flow("valid", { read: 1 }), flow("bad", {}, "rw")]),
    ];
    for (const begin of invalid) {
      const state = createState();
      open(state, { read: 3 });
      const before = structuredClone(state);
      const options = { relayOn: true };
      expect(validateFission(state, begin, options).ok).toBe(false);
      expect(splitFissionBudget(state, begin, options).ok).toBe(false);
      expect(state).toEqual(before);
    }
  });

  test("reserves inherited-property names as ordinary tool names", () => {
    const state = createState();
    const parent = open(state, { constructor: 2 });
    const result = splitFissionBudget(state, batch([flow("work", { constructor: 1 })]));
    expect(result.ok).toBe(true);
    expect(parent.remaining.constructor).toBe(1);
    expect(parent.spent.constructor).toBe(1);
  });

  test("rejects an unbudgeted inherited-property tool without mutation", () => {
    const state = createState();
    open(state, { read: 1 });
    const before = structuredClone(state);
    const result = chargeTool(state, { toolCallId: "call", toolName: "constructor" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("BUDGET_EXHAUSTED");
    expect(state).toEqual(before);
  });

  test("allows a root batch without a parent reservation", () => {
    const state = createState();
    const before = structuredClone(state);
    const result = splitFissionBudget(state, batch([flow("one", { read: 2 })]));
    expect(result.ok).toBe(true);
    expect(result.totals).toEqual({ read: 2 });
    expect(state).toEqual(before);
  });
});
