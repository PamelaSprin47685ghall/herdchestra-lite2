import { describe, test, expect } from "bun:test";

import { MessageLog } from "../../host-omp-ui/web/src/protocol/message-log.ts";

// The state holds a persistent sequence, not an array. These cases pin the
// places where "looks like an array" and "is an array" diverge, so a consumer
// that depends on the difference fails here rather than in the UI.
//
// `Array.isArray` cannot be made true for a non-array: it reads the value's
// internal class, which no proxy can change. That is why the sequence is
// modelled as `MessageSequence` instead of being cast to `UiMessage[]` — an
// array-shaped type would let `Array.isArray(messages)` compile and then take
// the array branch at run time with a non-array value.

const items = [
  { id: "a", role: "assistant", blocks: [{ type: "text", text: "one" }] },
  { id: "b", role: "assistant", blocks: [{ type: "text", text: "two" }] },
];

describe("serialisation", () => {
  test("JSON.stringify emits the messages, not the storage layout", () => {
    const log = MessageLog.from(items);
    // Before `toJSON`, this produced {"root":[…],"shift":…,"ancestors":…} —
    // the trie's internals. Anything that persisted, compared, or shipped the
    // conversation saw the wrong shape.
    expect(JSON.stringify(log)).toBe(JSON.stringify(items));
    expect(JSON.parse(JSON.stringify(log))).toEqual(items);
  });

  test("a nested sequence serialises through its parent", () => {
    const log = MessageLog.from(items);
    const frame = { messages: log, seq: 3 };
    expect(JSON.parse(JSON.stringify(frame))).toEqual({ messages: items, seq: 3 });
  });

  test("a derived sequence serialises the same way", () => {
    const log = MessageLog.from(items).replace(1, {
      id: "b",
      role: "assistant",
      blocks: [{ type: "text", text: "two!" }],
    });
    expect(JSON.parse(JSON.stringify(log))[1].blocks[0].text).toBe("two!");
    expect(JSON.parse(JSON.stringify(log))).toHaveLength(2);
  });
});

describe("array methods consumers reach for", () => {
  test("indexOf agrees with the array it was built from", () => {
    const log = MessageLog.from(items);
    expect(log.indexOf(items[0])).toBe(0);
    expect(log.indexOf(items[1])).toBe(1);
    expect(log.indexOf(items[1], 2)).toBe(-1);
    expect(log.indexOf({ id: "z", role: "assistant", blocks: [] })).toBe(-1);
  });

  test("reduce folds in index order", () => {
    const log = MessageLog.from(items);
    expect(log.reduce((ids, message) => [...ids, message.id], [])).toEqual(["a", "b"]);
    expect(log.reduce((count) => count + 1, 0)).toBe(2);
  });

  test("the methods a renderer uses keep working", () => {
    const log = MessageLog.from(items);
    expect(log.map((message) => message.id)).toEqual(["a", "b"]);
    expect(log.filter((message) => message.id === "b")).toEqual([items[1]]);
    expect(log.find((message) => message.id === "b")).toBe(items[1]);
    expect(log.findIndex((message) => message.id === "b")).toBe(1);
    expect(log.some((message) => message.id === "a")).toBe(true);
    expect(log.every((message) => message.role === "assistant")).toBe(true);
    expect(log.slice(1)).toEqual([items[1]]);
    expect(log.length).toBe(2);
  });
});

describe("what the sequence is not", () => {
  test("it is not an array, and the type says so", () => {
    const log = MessageLog.from(items);
    // Pinned deliberately: a consumer that needs a real array calls `toArray`,
    // and one that branches on `Array.isArray` must be given a real array.
    expect(Array.isArray(log)).toBe(false);
    expect(Array.isArray(log.toArray())).toBe(true);
    expect(log.toArray()).toEqual(items);
  });

  test("positional reads work without materialising", () => {
    const log = MessageLog.from(items);
    expect(log[0]).toBe(items[0]);
    expect(log[1]).toBe(items[1]);
    expect(log[2]).toBeUndefined();
    expect(0 in log).toBe(true);
    expect(2 in log).toBe(false);
  });

  test("mutation is not offered, so a stale write fails loudly", () => {
    const log = MessageLog.from(items);
    // A caller that treats the sequence as a mutable array gets a TypeError at
    // the call site instead of a silent no-op. Changing it means deriving a new
    // one, which is what keeps an already-rendered state from changing under
    // its readers.
    expect(typeof log.push).toBe("undefined");
    expect(typeof log.splice).toBe("undefined");
    const derived = log.replace(0, { id: "a", role: "assistant", blocks: [] });
    expect(derived).not.toBe(log);
    expect(log[0]).toBe(items[0]);
  });
});
