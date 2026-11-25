import { describe, test, expect } from "bun:test";

import { MessageLog } from "../../host-omp-ui/web/src/protocol/message-log.ts";

// A streaming frame replaces one message. Holding the history as a plain array
// made that replacement copy every element — Θ(history) references per tick —
// because React reports a change by identity. `MessageLog` shares structure
// instead: a replacement copies one chunk and its two index lists, and it
// records exactly which index moved so a consumer can reuse the prefix before
// it without comparing anything.

function messages(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: "assistant",
    blocks: [{ type: "text", text: `text ${index}` }],
  }));
}

describe("structural sharing", () => {
  test("replacing one message leaves every other message the same object", () => {
    const items = messages(2000);
    const log = MessageLog.from(items);
    const next = log.replace(1500, { ...items[1500], id: "m1500" });

    expect(next.length).toBe(log.length);
    for (let index = 0; index < items.length; index += 1) {
      if (index === 1500) continue;
      // Identity, not equality: the untouched history was not copied.
      expect(next.at(index)).toBe(items[index]);
    }
    expect(next.at(1500)).not.toBe(items[1500]);
    expect(next.at(1500).blocks[0].text).toBe("text 1500");
  });

  test("the previous log is not changed by the replacement", () => {
    const items = messages(700);
    const log = MessageLog.from(items);
    log.replace(3, { ...items[3], id: "changed" });

    expect(log.at(3).id).toBe("m3");
    expect(log.length).toBe(700);
  });

  test("a replacement copies one chunk, not the sequence", () => {
    // Chunk size is an implementation constant; the property that matters is
    // that replacing an index touches a bounded neighbourhood, not the whole
    // history. Two replacements in the same chunk must share every chunk
    // outside it, which shows up as identity for the messages they hold.
    const items = messages(5000);
    const log = MessageLog.from(items);
    const a = log.replace(10, { ...items[10] });
    const b = log.replace(20, { ...items[20] });

    for (let index = 0; index < items.length; index += 1) {
      if (index === 10 || index === 20) continue;
      expect(a.at(index)).toBe(items[index]);
      expect(b.at(index)).toBe(items[index]);
    }
  });

  test("indices across chunk and level boundaries resolve", () => {
    // 32 and 1024 are the capacities of a one- and two-level tree: 1100 items
    // reaches depth two, so `at` is exercised at every level without feeding it
    // a session-sized input.
    const items = messages(1100);
    const log = MessageLog.from(items);
    for (const index of [0, 31, 32, 33, 1023, 1024, 1099]) {
      expect(log.at(index)).toBe(items[index]);
    }
    const next = log.replace(1024, { ...items[1024], id: "boundary" });
    expect(next.at(1024).id).toBe("boundary");
    expect(next.at(1023)).toBe(items[1023]);
    expect(next.at(1025)).toBe(items[1025]);
  });
});

describe("provenance", () => {
  test("a replacement reports exactly the index that moved", () => {
    const log = MessageLog.from(messages(1000));
    expect(log.replace(777, { id: "x", role: "assistant", blocks: [] }).dirtyFrom).toBe(777);
  });

  test("appending moves nothing that existed before", () => {
    const log = MessageLog.from(messages(10));
    const next = log.append({ id: "tail", role: "assistant", blocks: [] });
    // The prefix is untouched, so the first index that differs is the old end.
    expect(next.dirtyFrom).toBe(10);
    expect(next.length).toBe(11);
    expect(next.at(0)).toBe(log.at(0));
  });

  test("prepending moves every position", () => {
    const log = MessageLog.from(messages(10));
    const next = log.prepend([{ id: "older", role: "user", blocks: [] }]);
    expect(next.dirtyFrom).toBe(0);
    expect(next.length).toBe(11);
    expect(next.at(0).id).toBe("older");
    expect(next.at(1)).toBe(log.at(0));
  });

  test("a log handed back to from() keeps its provenance", () => {
    const log = MessageLog.from(messages(5));
    const moved = log.replace(2, { id: "z", role: "assistant", blocks: [] });
    // Copying it would reset the provenance and reintroduce the per-frame copy.
    expect(MessageLog.from(moved)).toBe(moved);
    expect(MessageLog.from(moved).dirtyFrom).toBe(2);
  });

  test("an array built from scratch claims nothing about its prefix", () => {
    expect(MessageLog.from(messages(4)).dirtyFrom).toBe(0);
  });
});

describe("array-compatible reads", () => {
  test("iteration, map, find and findIndex match array semantics", () => {
    const items = messages(1200);
    const log = MessageLog.from(items);

    expect([...log].length).toBe(items.length);
    expect([...log][1100]).toBe(items[1100]);
    expect(log.map((message) => message.id)).toEqual(items.map((m) => m.id));
    expect(log.findIndex((message) => message.id === "m900")).toBe(900);
    expect(log.find((message) => message.id === "m5")).toBe(items[5]);
    expect(log.some((message) => message.id === "m1199")).toBe(true);
    expect(log.every((message) => message.role === "assistant")).toBe(true);
    expect(log.filter((message) => message.id === "m7")).toEqual([items[7]]);
  });

  test("slice and toArray materialise the same elements", () => {
    const items = messages(600);
    const log = MessageLog.from(items);
    expect(log.slice(5, 9)).toEqual(items.slice(5, 9));
    expect(log.slice(-3)).toEqual(items.slice(-3));
    expect(log.toArray()).toEqual(items);
    expect(log.toArray()[599]).toBe(items[599]);
  });

  test("out-of-range reads are empty rather than wrong", () => {
    const log = MessageLog.from(messages(3));
    expect(log.at(-1)).toBeUndefined();
    expect(log.at(3)).toBeUndefined();
    expect(log.at(1.5)).toBeUndefined();
    expect(log.slice(10, 20)).toEqual([]);
    expect(log.replace(99, { id: "x", role: "assistant", blocks: [] })).toBe(log);
  });

  test("an empty log is a valid starting point", () => {
    const empty = MessageLog.empty();
    expect(empty.length).toBe(0);
    expect(empty.isEmpty).toBe(true);
    expect([...empty]).toEqual([]);
    const one = empty.append({ id: "first", role: "user", blocks: [] });
    expect(one.length).toBe(1);
    expect(one.at(0).id).toBe("first");
  });
});

describe("provenance needs ancestry, not just dirtyFrom", () => {
  const msg = (id) => ({ id, role: "assistant", blocks: [] });

  test("a log compared with itself differs nowhere", () => {
    const log = MessageLog.from(messages(5));
    expect(log.diffFrom(log)).toBe(5);
  });

  test("two children of one parent are not ancestors of each other", () => {
    const root = MessageLog.from(messages(1000));
    const left = root.replace(3, msg("left"));
    const right = root.replace(900, msg("right"));

    // Both report a small dirtyFrom relative to `root`. Reading that field and
    // assuming it describes the other child would claim left[3] === right[3],
    // which is false, and a consumer would reuse a stale prefix.
    expect(left.dirtyFrom).toBe(3);
    expect(right.dirtyFrom).toBe(900);
    expect(left.diffFrom(right)).toBe(0);
    expect(right.diffFrom(left)).toBe(0);
  });

  test("a grandparent is compared through the whole path", () => {
    const first = MessageLog.from(messages(2000));
    const second = first.replace(1500, msg("b"));
    const third = second.replace(10, msg("c"));

    // The first difference from `first` is the earliest move on the path, not
    // the newest one: `third.dirtyFrom` alone names index 10 and would hide
    // that index 1500 also moved.
    expect(third.diffFrom(first)).toBe(10);
    expect(second.diffFrom(first)).toBe(1500);
    expect(third.diffFrom(second)).toBe(10);
    expect(third.diffFrom(third)).toBe(third.length);
  });

  test("an appended message leaves the prefix comparable", () => {
    const first = MessageLog.from(messages(40));
    const appended = first.append(msg("tail"));
    expect(appended.diffFrom(first)).toBe(40);
    const replaced = appended.replace(39, msg("39"));
    expect(replaced.diffFrom(first)).toBe(39);
    expect(replaced.diffFrom(appended)).toBe(39);
  });

  test("the retained window is bounded, and evicted versions answer conservatively", () => {
    let log = MessageLog.from(messages(200));
    const early = log.replace(5, msg("early"));
    log = early;
    for (let step = 0; step < 20; step += 1) {
      log = log.replace(100 + step, msg(`step-${step}`));
    }
    // Far past the window: the consumer must regroup rather than guess.
    expect(log.diffFrom(early)).toBe(0);
    // The most recent step is still known.
    expect(log.diffFrom(log)).toBe(log.length);
  });

  test("a rebuilt log from the same array is a different history", () => {
    const items = messages(30);
    const a = MessageLog.from(items);
    const b = MessageLog.from(items);
    // Equal contents, no shared lineage: reusing a prefix across them would be
    // an assumption the log cannot support.
    expect(a.diffFrom(b)).toBe(0);
    expect(a.diffFrom(a)).toBe(30);
  });
});

describe("bounded cost at scale", () => {
  test("replacement deep in a multi-level tree keeps every other node", () => {
    // 1100 messages reach depth two. The property under test — that a
    // replacement shares every subtree off its path — does not become more true
    // with a session-sized input, so the input stays small.
    const items = messages(1100);
    const log = MessageLog.from(items);
    expect(log.length).toBe(1100);
    const next = log.replace(543, { ...items[543], id: "hit" });

    // Spot-check across the tree's levels and around the touched path: the
    // untouched history is shared, not rebuilt.
    for (const index of [0, 31, 32, 1023, 542, 544, 1099]) {
      expect(next.at(index)).toBe(items[index]);
    }
    expect(next.at(543).id).toBe("hit");
    expect(next.at(543)).not.toBe(items[543]);
  });

  test("growing past each capacity boundary keeps indices correct", () => {
    // 32, 1024 and 32768 are the capacities of a tree one, two and three levels
    // deep. A log crossing each must address every position exactly once.
    let log = MessageLog.empty();
    for (let index = 0; index < 1100; index += 1) {
      log = log.append({ id: `m${index}`, role: "assistant", blocks: [] });
      expect(log.length).toBe(index + 1);
    }
    for (const index of [0, 31, 32, 33, 1023, 1024, 1099]) {
      expect(log.at(index)?.id).toBe(`m${index}`);
    }
    expect(log.toArray().map((message) => message.id)).toEqual(
      Array.from({ length: 1100 }, (_, index) => `m${index}`),
    );
    expect(log.at(1100)).toBeUndefined();
  });

  test("iteration order is index order after replacements", () => {
    let log = MessageLog.from(messages(500));
    log = log.replace(0, { id: "first", role: "user", blocks: [] });
    log = log.replace(499, { id: "last", role: "user", blocks: [] });
    const ids = [...log].map((message) => message.id);
    expect(ids[0]).toBe("first");
    expect(ids[499]).toBe("last");
    expect(ids.length).toBe(500);
  });
});

describe("iteration is lazy", () => {
  test("a partial walk stops without visiting the rest of the history", () => {
    // `find` and `findIndex` return at the first match. If the iterator
    // materialised the history first, every early return would still pay for
    // the whole list — the allocation this change removes.
    const items = messages(800);
    const log = MessageLog.from(items);
    const visited = [];
    for (const message of log) {
      visited.push(message.id);
      if (message.id === "m2") break;
    }
    // Only the messages up to the break were produced, not all 800.
    expect(visited).toEqual(["m0", "m1", "m2"]);
  });

  test("find stops at the first match and still answers it", () => {
    const items = messages(800);
    const log = MessageLog.from(items);
    expect(log.find((message) => message.id === "m1")).toBe(items[1]);
    expect(log.findIndex((message) => message.id === "m1")).toBe(1);
    expect(log.find((message) => message.id === "nope")).toBeUndefined();
  });

  test("full iteration still yields every message in order after a replace", () => {
    let log = MessageLog.from(messages(100));
    log = log.replace(50, { id: "changed", role: "assistant", blocks: [] });
    const ids = [...log].map((message) => message.id);
    expect(ids.length).toBe(100);
    expect(ids[50]).toBe("changed");
    expect(ids[49]).toBe("m49");
    expect(ids[51]).toBe("m51");
    // toArray and the iterator agree.
    expect(log.toArray().map((message) => message.id)).toEqual(ids);
  });
});

describe("numeric index view", () => {
  test("positional reads answer the message an array would hold", () => {
    const items = messages(1100);
    const log = MessageLog.from(items);
    // Every crossed boundary: leaf (32), inner (1024), and the tail.
    for (const index of [0, 31, 32, 33, 1023, 1024, 1099]) {
      expect(log[index]).toBe(items[index]);
    }
    expect(log[1100]).toBeUndefined();
    expect(log[-1]).toBeUndefined();
  });

  test("the view survives a replacement and stays positional", () => {
    let log = MessageLog.from(messages(100));
    log = log.replace(50, { id: "changed", role: "assistant", blocks: [] });
    expect(log[50].id).toBe("changed");
    expect(log[49].id).toBe("m49");
    expect(log[51].id).toBe("m51");
    // A fresh derivation is still indexable, not just the original.
    const appended = log.append({ id: "tail", role: "assistant", blocks: [] });
    expect(appended[100].id).toBe("tail");
    expect(appended[50].id).toBe("changed");
  });

  test("non-index keys are untouched", () => {
    const log = MessageLog.from(messages(40));
    expect(log.length).toBe(40);
    expect(typeof log.at).toBe("function");
    expect(typeof log[Symbol.iterator]).toBe("function");
    // Array-like truthiness must not turn a method name into an index.
    expect(log["01"]).toBeUndefined();
    expect(log["0x1"]).toBeUndefined();
    expect(log["1e2"]).toBeUndefined();
    // Membership agrees with the index view.
    expect(3 in log).toBe(true);
    expect(40 in log).toBe(false);
  });

  test("iteration and indexing agree after many derivations", () => {
    let log = MessageLog.from(messages(70));
    for (let step = 0; step < 12; step += 1) {
      log = log.replace(step, { id: `r${step}`, role: "assistant", blocks: [] });
    }
    const fromIteration = [...log].map((message) => message.id);
    const fromIndex = Array.from({ length: log.length }, (_, index) => log[index].id);
    expect(fromIndex).toEqual(fromIteration);
    expect(fromIndex[11]).toBe("r11");
    expect(fromIndex[12]).toBe("m12");
  });
});
