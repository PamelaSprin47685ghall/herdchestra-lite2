import { describe, expect, test } from "bun:test";

import { applyDelta, diffState } from "../src/scope/persistence.mjs";

// The diff walk keeps its path on a stack and copies it only when it emits an
// operation. That is an allocation change, so the contract has to be pinned on
// what an emitted operation says, not on how the walk got there: every op must
// carry the exact path to the value it names, and applying the ops must rebuild
// the target from the base.
//
// The cases are the ones a transcript produces: an append, a truncation, a
// nested field, a removed key and an array element replaced in place.

const base = () => ({
  forkId: "a",
  status: "running",
  budget: { read: 1, write: 2 },
  messages: [
    { role: "user", text: "one", blocks: [{ type: "text", text: "x" }] },
    { role: "assistant", text: "two", blocks: [{ type: "text", text: "y" }] },
  ],
  inbox: [{ from: "/api", message: "m1" }],
});

describe("the paths a diff emits", () => {
  test("an appended array element is named by its index", () => {
    const before = base();
    const after = { ...before, messages: [...before.messages, { role: "user", text: "three" }] };
    const ops = diffState(before, after);

    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("set");
    expect(ops[0].path).toEqual(["messages", 2]);
    expect(ops[0].value).toEqual({ role: "user", text: "three" });
    expect(applyDelta(structuredClone(before), ops)).toEqual(after);
  });

  test("a shortened array truncates at its own path", () => {
    const before = base();
    const after = { ...before, messages: before.messages.slice(0, 1) };
    const ops = diffState(before, after);

    expect(ops).toEqual([{ op: "trunc", path: ["messages"], length: 1 }]);
    expect(applyDelta(structuredClone(before), ops)).toEqual(after);
  });

  test("a nested field is named from the root", () => {
    const before = base();
    const after = { ...before, budget: { ...before.budget, read: 7 } };
    const ops = diffState(before, after);

    expect(ops).toEqual([{ op: "set", path: ["budget", "read"], value: 7 }]);
    expect(applyDelta(structuredClone(before), ops)).toEqual(after);
  });

  test("a removed key is deleted at its own path", () => {
    const before = base();
    const after = { ...before };
    delete after.status;
    const ops = diffState(before, after);

    expect(ops).toEqual([{ op: "del", path: ["status"] }]);
    expect(applyDelta(structuredClone(before), ops)).toEqual(after);
  });

  test("an element replaced in place is named by its index, not by the array", () => {
    const before = base();
    const after = {
      ...before,
      messages: before.messages.map((message, index) =>
        index === 1 ? { ...message, text: "changed" } : message,
      ),
    };
    const ops = diffState(before, after);

    expect(ops).toEqual([{ op: "set", path: ["messages", 1, "text"], value: "changed" }]);
    expect(applyDelta(structuredClone(before), ops)).toEqual(after);
  });

  test("an unchanged record diffs to nothing", () => {
    const before = base();
    const copy = structuredClone(before);
    expect(diffState(before, copy)).toEqual([]);
    expect(applyDelta(structuredClone(before), [])).toEqual(copy);
  });

  test("a deep copy of the base diffs to exactly what the live base diffs to", () => {
    const before = base();
    const after = { ...before, status: "ready", messages: [...before.messages, { role: "user", text: "three" }] };

    // The stored base is a copy, so no node in it is the live object. The paths
    // must still name the same places.
    const fromCopy = diffState(structuredClone(before), after);
    expect(fromCopy).toEqual(diffState(before, after));
    expect(applyDelta(structuredClone(before), fromCopy)).toEqual(after);
  });

  test("emitted paths are independent of the walk that produced them", () => {
    const before = base();
    const after = {
      ...before,
      budget: { ...before.budget, write: 9 },
      messages: [...before.messages, { role: "user", text: "three" }],
    };
    const ops = diffState(before, after);

    // Destructuring the path of one op must not be affected by the other, which
    // is what a shared (stack) array would break. The paths differ here, so any
    // aliasing between them would also change what one of them says.
    expect(ops.length).toBeGreaterThan(1);
    const distinct = new Set(ops.map((op) => op.path.join("/")));
    expect(distinct.size).toBe(ops.length);
    expect(ops.map((op) => op.path)).toEqual([["budget", "write"], ["messages", 2]]);
    expect(applyDelta(structuredClone(before), ops)).toEqual(after);
  });
});
