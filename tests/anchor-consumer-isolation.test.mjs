import { describe, expect, test } from "bun:test";
import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";
import { createBracketLedger } from "../src/scope/ledger-brackets.mjs";
import { markRecordDirty } from "../src/scope/ledger-cache.mjs";
import { consumerPending } from "../src/scope/ledger-cache.mjs";

function anchor(state, fail = false) {
  const ids = [];
  const manager = {
    appendCustomEntry() { if (fail) throw Error("write failed"); return "entry"; },
    getLeafId() { return "entry"; },
  };
  const instance = createPersistenceAnchor({
    manager, state: () => state, initialState: null, initialEntryId: null,
    serialize: () => ({}), split: (core) => ({ core }),
    plan: () => ({ kind: "checkpoint" }),
    planLedger: (current, previous, id) => {
      ids.push(id);
      return { entry: { kind: "ledger", set: {}, del: [], head: null }, brackets: {} };
    },
    type: "scope.state", noteError() {},
  });
  return { instance, ids };
}

describe("anchor-specific ledger consumers", () => {
  test("successful writes clear only their own pending records", () => {
    const state = { brackets: createBracketLedger() };
    const first = anchor(state);
    const second = anchor(state, true);
    expect(first.instance.persist()).toBe(true);
    expect(second.instance.persist()).toBe(false);
    const [a] = first.ids;
    const [b] = second.ids;
    expect(a).not.toBe(b);
    markRecordDirty(state.brackets, "fork-a");
    expect(first.instance.persist()).toBe(true);
    expect(consumerPending(state.brackets, a).records).toEqual([]);
    expect(consumerPending(state.brackets, b).records).toEqual(["fork-a"]);
  });

  test("a synchronous append mutation remains pending after the older write", () => {
    const state = { brackets: createBracketLedger() };
    let consumer;
    const manager = {
      getLeafId: () => "entry",
      appendCustomEntry() {
        markRecordDirty(state.brackets, "during-append");
        return "entry";
      },
    };
    const writer = createPersistenceAnchor({
      manager, state: () => state, initialState: null, initialEntryId: null,
      serialize: () => ({}), split: (core) => ({ core }),
      plan: () => ({ kind: "checkpoint" }),
      planLedger: (_state, _previous, id) => {
        consumer = id;
        return { entry: { kind: "ledger", set: {}, del: [], head: null }, brackets: {} };
      },
      type: "scope.state", noteError() {},
    });
    expect(writer.persist()).toBe(true);
    expect(consumerPending(state.brackets, consumer).records).toEqual(["during-append"]);
  });

  test("replacing the live ledger requires a fresh baseline", () => {
    const state = { brackets: createBracketLedger() };
    const first = anchor(state);
    expect(first.instance.persist()).toBe(true);
    const id = first.ids[0];
    const old = state.brackets;
    state.brackets = createBracketLedger();
    expect(first.instance.persist()).toBe(true);
    expect(consumerPending(old, id).struct).toBe(true);
    markRecordDirty(state.brackets, "fork-b");
    expect(consumerPending(state.brackets, id).records).toEqual(["fork-b"]);
  });
});
