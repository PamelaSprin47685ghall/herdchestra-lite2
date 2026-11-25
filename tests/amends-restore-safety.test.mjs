import { test, expect } from "bun:test";
import { createState, serializeState, serializeStateCore, planAmendsEntry, planLedgerEntry, planStateEntry, splitState } from "../src/scope/index.mjs";
import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";
import { restoreState } from "../src/station/restore.mjs";

function setup() {
  const state = createState();
  const records = new Map([["base", { id: "base", parentId: null }]]);
  let leaf = "base", serial = 0, fail = false;
  const manager = {
    getLeafId: () => leaf,
    getLeafEntry: () => records.get(leaf),
    getBranch: () => { const result = []; for (let id = leaf; id; id = records.get(id)?.parentId) result.unshift(records.get(id)); return result; },
    appendCustomEntry: (type, data) => { if (fail) { fail = false; throw new Error("failed"); } const id = String(++serial); records.set(id, { id, parentId: leaf, type: "custom", customType: type, data }); leaf = id; return id; },
    cut: (id) => { leaf = id; },
    fail: () => { fail = true; },
  };
  const anchor = createPersistenceAnchor({ manager, state: () => state, initialState: null, initialEntryId: null, serialize: serializeStateCore, plan: planStateEntry, planLedger: planLedgerEntry, planAmends: planAmendsEntry, split: splitState, type: "scope.state", noteError: () => {} });
  return { state, manager, anchor };
}

test("full serialization preserves retired keys", () => { const s = createState(); s.amends.push("a"); expect(serializeState(s).amends).toEqual(["a"]); expect(serializeStateCore(s).amends).toBeUndefined(); });
test("restore reads standalone and embedded increments older than latest checkpoint", () => { const {state, manager, anchor} = setup(); state.amends.push("a"); expect(anchor.persist()).toBe(true); state.amends.push("b"); expect(anchor.persist()).toBe(true); for (let i=0;i<66;i++) {state.seq++; expect(anchor.persist()).toBe(true);} expect(restoreState(manager).amends).toEqual(["a", "b"]); });
test("branch cut and failed append cannot lose retired keys", () => { const {state, manager, anchor} = setup(); state.amends.push("a"); expect(anchor.persist()).toBe(true); const base=manager.getLeafId(); state.amends.push("b"); expect(anchor.persist()).toBe(true); manager.cut(base); state.amends.push("c"); manager.fail(); expect(anchor.persist()).toBe(false); expect(anchor.persist()).toBe(true); expect(restoreState(manager).amends).toEqual(["a", "b", "c"]); });
test("empty replacement baseline removes old values", () => { const {state, manager, anchor} = setup(); state.amends.push("a"); expect(anchor.persist()).toBe(true); state.amends=[]; expect(anchor.persist()).toBe(true); expect(restoreState(manager).amends).toEqual([]); });

test("same-array same-length edits and subsequent appends survive restore", () => {
  const { state, manager, anchor } = setup();
  state.amends.push("old");
  expect(anchor.persist()).toBe(true);
  state.amends[0] = "corrected";
  expect(anchor.persist()).toBe(true);
  state.amends.push("later");
  expect(anchor.persist()).toBe(true);
  expect(restoreState(manager).amends).toEqual(["corrected", "later"]);
});

test("same-array edit during host append is retained by the next write", () => {
  const { state, manager, anchor } = setup();
  state.amends.push("old");
  const append = manager.appendCustomEntry;
  let edited = false;
  manager.appendCustomEntry = (type, data) => {
    const id = append(type, data);
    if (!edited) { edited = true; state.amends[0] = "corrected"; }
    return id;
  };
  expect(anchor.persist()).toBe(true);
  expect(anchor.persist()).toBe(true);
  expect(restoreState(manager).amends).toEqual(["corrected"]);
});

test("nested persistence during host append does not lose the newer state", () => {
  const { state, manager, anchor } = setup();
  state.amends.push("first");
  const append = manager.appendCustomEntry;
  let reentered = false;
  manager.appendCustomEntry = (type, data) => {
    const id = append(type, data);
    if (!reentered) {
      reentered = true;
      state.amends.push("second");
      expect(anchor.persist()).toBe(true);
    }
    return id;
  };
  expect(anchor.persist()).toBe(true);
  state.amends.push("third");
  expect(anchor.persist()).toBe(true);
  expect(restoreState(manager).amends).toEqual(["first", "second", "third"]);
});

test("rebase during host append forces a complete replacement on the new branch", () => {
  const { state, manager, anchor } = setup();
  state.amends.push("one");
  expect(anchor.persist()).toBe(true);
  const append = manager.appendCustomEntry;
  let reentered = false;
  manager.appendCustomEntry = (type, data) => {
    const id = append(type, data);
    if (!reentered) {
      reentered = true;
      manager.cut("base");
      state.amends.push("two");
      anchor.rebase();
    }
    return id;
  };
  state.amends.push("before-cut");
  expect(anchor.persist()).toBe(true);
  expect(restoreState(manager).amends).toEqual(["one", "before-cut", "two"]);
});

test("replacement during host append is restated on the next write", () => {
  const { state, manager, anchor } = setup();
  state.amends.push("old");
  const append = manager.appendCustomEntry;
  let replaced = false;
  manager.appendCustomEntry = (type, data) => {
    const id = append(type, data);
    if (!replaced) {
      replaced = true;
      state.amends = ["new"];
    }
    return id;
  };
  expect(anchor.persist()).toBe(true);
  expect(anchor.persist()).toBe(true);
  expect(restoreState(manager).amends).toEqual(["new"]);
});
