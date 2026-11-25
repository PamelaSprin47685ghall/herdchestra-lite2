import { expect, test } from "bun:test";
import { foldStateChain } from "../src/scope/persistence.mjs";

test("replay preserves order across duplicate removals and re-appends", () => {
  const entries = [
    { version: 3, kind: "ledger", full: true, set: {}, del: [], order: ["a", "b", "a", "c"], queues: { root: ["x", "y", "x"] }, levels: {} },
    { version: 3, kind: "ledger", set: {}, del: [], orderOps: { remove: ["a"], append: ["a", "d", "a"] }, queuesOps: { owners: { root: { remove: ["x"], append: ["x", "x"] } }, removed: [] } },
    { version: 3, kind: "ledger", set: {}, del: [], orderOps: { remove: ["c"], append: ["c"] } },
  ];
  const original = JSON.stringify(entries);
  const first = foldStateChain(entries);
  expect(first.brackets.order).toEqual(["b", "a", "d", "c"]);
  expect(first.brackets.queues.root).toEqual(["y", "x"]);
  expect(JSON.stringify(entries)).toBe(original);
  first.brackets.order.push("outside");
  expect(foldStateChain(entries).brackets.order).toEqual(["b", "a", "d", "c"]);
});

test("replay agrees with the array model for small ordered edits", () => {
  // Exhaust the short lists and operations that expose duplicate removal,
  // re-addition and ordering. This is a deterministic functional comparison,
  // not a timing or load test.
  const lists = [[], ["a"], ["b"], ["a", "a"], ["a", "b"], ["b", "a"]];
  const changes = [
    {},
    { remove: ["a"], append: ["b", "a"] },
    { remove: ["b", "a"], append: ["a", "a"] },
    { append: ["b", "a", "b"] },
    { reset: ["b", "b", "a"] },
    { reset: [] },
  ];
  const apply = (base, ops) => {
    if (Array.isArray(ops.reset)) return ops.reset.slice();
    let result = base.slice();
    if (Array.isArray(ops.remove)) {
      const removed = new Set(ops.remove);
      result = result.filter((item) => !removed.has(item));
    }
    if (Array.isArray(ops.append)) {
      const present = new Set(result);
      for (const item of ops.append) {
        if (present.has(item)) continue;
        result.push(item);
        present.add(item);
      }
    }
    return result;
  };
  for (const initial of lists) {
    for (const first of changes) {
      for (const second of changes) {
        const entries = [
          { version: 3, kind: "ledger", full: true, set: {}, del: [], order: initial, queues: { root: initial }, levels: { level: initial } },
          { version: 3, kind: "ledger", set: {}, del: [], orderOps: first, queuesOps: { owners: { root: first }, removed: [] }, levelsOps: { owners: { level: first }, removed: [] } },
          { version: 3, kind: "ledger", set: {}, del: [], orderOps: second, queuesOps: { owners: { root: second }, removed: [] }, levelsOps: { owners: { level: second }, removed: [] } },
        ];
        const source = JSON.stringify(entries);
        const expected = apply(apply(initial, first), second);
        const folded = foldStateChain(entries);
        expect(folded.brackets.order).toEqual(expected);
        expect(folded.brackets.queues.root).toEqual(expected);
        expect(folded.brackets.levels.level).toEqual(expected);
        expect(JSON.stringify(entries)).toBe(source);
      }
    }
  }
});

test("reset replaces earlier lists and later edits remain ordered", () => {
  const entries = [
    { version: 3, kind: "ledger", full: true, set: {}, del: [], order: ["old"] },
    { version: 3, kind: "ledger", set: {}, del: [], orderOps: { reset: ["x", "x", "y"] } },
    { version: 3, kind: "ledger", set: {}, del: [], orderOps: { remove: ["x"], append: ["x"] } },
  ];
  expect(foldStateChain(entries).brackets.order).toEqual(["y", "x"]);
});
