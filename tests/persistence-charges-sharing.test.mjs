import { expect, test } from "bun:test";
import {
  serializeState,
  serializeStateCore,
  serializeStateShared,
  diffState,
} from "../src/scope/persistence.mjs";
import { createState } from "../src/scope/state.mjs";

function stateWithCharges(count) {
  const state = createState();
  for (let index = 0; index < count; index += 1) {
    state.charges[`call-${index}`] = { ownerId: "fork", tool: "bash", amount: 1 };
  }
  return state;
}

test("an unchanged charge table keeps its identity on the shared path", () => {
  const state = stateWithCharges(3);
  const first = serializeStateShared(state);
  const second = serializeStateShared(state);
  // Identity is what lets `diffState` skip the table instead of walking every
  // charge and finding nothing.
  expect(second.charges).toBe(first.charges);
  expect(diffState(first, second)).toEqual([]);
});

test("the delta hot path shares the charge table it did not change", () => {
  const state = stateWithCharges(3);
  const first = serializeStateCore(state);
  const second = serializeStateCore(state);
  expect(second.charges).toBe(first.charges);
  expect(diffState(first, second)).toEqual([]);
});

test("serializeState hands the caller its own charge table", () => {
  const state = stateWithCharges(2);
  const first = serializeState(state);
  const second = serializeState(state);
  // `serializeState` promises objects the caller owns: a caller holding two
  // snapshots may write one and still read the other.
  expect(second.charges).not.toBe(first.charges);
  first.charges["call-0"].amount = 99;
  delete first.charges["call-1"];
  expect(second.charges["call-0"].amount).toBe(1);
  expect(second.charges["call-1"]).toBeDefined();
  expect(state.charges["call-0"].amount).toBe(1);
});

test("a new charge is visible through the shared table", () => {
  const state = stateWithCharges(2);
  const first = serializeStateShared(state);
  state.charges["call-2"] = { ownerId: "fork", tool: "read", amount: 2 };
  const second = serializeStateShared(state);
  expect(second.charges).not.toBe(first.charges);
  expect(second.charges["call-2"]).toEqual({
    ownerId: "fork",
    tool: "read",
    amount: 2,
  });
  // The earlier snapshot is a baseline, not a view: it still holds what it held.
  expect(first.charges["call-2"]).toBeUndefined();
  expect(diffState(first, second)).toEqual([
    {
      op: "set",
      path: ["charges", "call-2"],
      value: { ownerId: "fork", tool: "read", amount: 2 },
    },
  ]);
});

test("a replaced charge entry is visible through the shared table", () => {
  const state = stateWithCharges(2);
  const first = serializeStateShared(state);
  state.charges["call-0"] = { ownerId: "fork", tool: "bash", amount: 9 };
  const second = serializeStateShared(state);
  expect(second.charges).not.toBe(first.charges);
  expect(second.charges["call-0"].amount).toBe(9);
});

test("a deleted charge is visible through the shared table", () => {
  const state = stateWithCharges(2);
  const first = serializeStateShared(state);
  delete state.charges["call-1"];
  const second = serializeStateShared(state);
  expect(second.charges).not.toBe(first.charges);
  expect(Object.hasOwn(second.charges, "call-1")).toBe(false);
  expect(diffState(first, second)).toEqual([
    { op: "del", path: ["charges", "call-1"] },
  ]);
});

test("unchanged pins keep their identity, model caches do not", () => {
  const state = createState();
  state.pins = ["first", "second"];
  state.modelCaches = { model: { cachedUntilPos: 4, lastUsedAt: 1, tokensPerChar: 0.3 } };
  const first = serializeStateShared(state);
  const second = serializeStateShared(state);
  expect(second.pins).toBe(first.pins);
  // `modelCaches` is rebuilt on purpose: its entries move in place, so a
  // reference comparison would miss the change.
  expect(second.modelCaches).toEqual(first.modelCaches);
  expect(second.modelCaches).not.toBe(first.modelCaches);
  state.pins.push("third");
  state.modelCaches.model.cachedUntilPos = 9;
  const third = serializeStateShared(state);
  expect(third.pins).not.toBe(first.pins);
  expect(third.pins).toEqual(["first", "second", "third"]);
  expect(third.modelCaches.model.cachedUntilPos).toBe(9);
});

test("an unchanged call still yields an empty delta", () => {
  const state = stateWithCharges(2);
  const prev = serializeStateShared(state);
  const next = serializeStateShared(state);
  expect(diffState(prev, next)).toEqual([]);
});
