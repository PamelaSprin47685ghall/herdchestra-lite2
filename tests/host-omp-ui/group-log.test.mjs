import { describe, test, expect } from "bun:test";

import { GroupLog } from "../../host-omp-ui/web/src/lib/build-steps.ts";

// A settled group sequence. The grouping code reads `length` on every frame and
// the scroll code slices a visible window out of it, so both have to cost what
// they touch: `length` must be a stored count, and `slice` must visit only the
// range it returns. These cases check the results against an array, because a
// wrong bound or a stale count shows up as a wrong list.

const group = (index) => ({ kind: "user", id: `g${index}`, message: { id: `m${index}` } });

function build(count) {
  let log = GroupLog.empty();
  for (let index = 0; index < count; index += 1) log = log.append(group(index));
  return log;
}

describe("length", () => {
  test("counts what was appended, without walking", () => {
    const log = build(40);
    expect(log.length).toBe(40);
    // A replace changes no member count.
    expect(log.replace(7, group(7)).length).toBe(40);
    expect(GroupLog.empty().length).toBe(0);
    expect(GroupLog.empty().append(group(0)).length).toBe(1);
  });

  test("stays exact while growing past a level boundary", () => {
    const log = build(1100);
    expect(log.length).toBe(1100);
    expect(log[1099].id).toBe("g1099");
    expect(log[0].id).toBe("g0");
  });
});

describe("slice", () => {
  const base = Array.from({ length: 40 }, (_, index) => group(index));
  const log = build(40);

  const cases = [
    [5, 9],
    [0, 0],
    [0, 3],
    [39, 40],
    [40, 42],
    [-3, undefined],
    [-2, -1],
    [-100, 2],
    [1e9, undefined],
    [-1e9, undefined],
    [3.7, 8.2],
    [NaN, undefined],
    [0, NaN],
    [undefined, NaN],
  ];

  for (const [from, to] of cases) {
    test(`slice(${String(from)}, ${String(to)})`, () => {
      expect(log.slice(from, to).map((item) => item.id)).toEqual(
        base.slice(from, to).map((item) => item.id),
      );
    });
  }

  test("answers a window out of the middle without disturbing the rest", () => {
    expect(log.slice(10, 13).map((item) => item.id)).toEqual(["g10", "g11", "g12"]);
    expect(log.length).toBe(40);
    expect(log.slice(0, 1)[0].id).toBe("g0");
  });

  test("an empty range is an empty list, not a missing one", () => {
    expect(log.slice(7, 7)).toEqual([]);
    expect(log.slice(-1, -5)).toEqual([]);
    expect(GroupLog.empty().slice()).toEqual([]);
  });

  test("a range that crosses a leaf boundary is ordered", () => {
    const wide = build(1100);
    expect(wide.slice(30, 34).map((item) => item.id)).toEqual(["g30", "g31", "g32", "g33"]);
    expect(wide.slice(1022, 1026).map((item) => item.id)).toEqual([
      "g1022",
      "g1023",
      "g1024",
      "g1025",
    ]);
  });
});

describe("iteration", () => {
  test("is lazy: a caller that stops early visits only what it read", () => {
    const log = build(500);
    const visited = [];
    for (const item of log) {
      visited.push(item.id);
      if (visited.length === 3) break;
    }
    expect(visited).toEqual(["g0", "g1", "g2"]);
  });

  test("produces every group in order and agrees with toArray", () => {
    const log = build(70);
    const fromIterator = [...log].map((item) => item.id);
    expect(fromIterator).toEqual(log.toArray().map((item) => item.id));
    expect(fromIterator.length).toBe(70);
    expect(fromIterator[69]).toBe("g69");
  });

  test("map and find read positions in order", () => {
    const log = build(30);
    expect(log.map((item) => item.id).length).toBe(30);
    expect(log.find((item) => item.id === "g12").id).toBe("g12");
    expect(log.findIndex((item) => item.id === "g12")).toBe(12);
  });
});

describe("positional reads", () => {
  test("indices answer what the array holds, including negatives on at()", () => {
    const log = build(50);
    expect(log[0].id).toBe("g0");
    expect(log[49].id).toBe("g49");
    expect(log[50]).toBeUndefined();
    expect(log[64]).toBeUndefined();
    expect(log[96]).toBeUndefined();
    expect(log.at(64)).toBeUndefined();
    expect(log.at(-1).id).toBe("g49");
    expect(log.at(-50).id).toBe("g0");
    expect(log.at(-51)).toBeUndefined();
  });

  test("a replacement leaves the earlier version untouched", () => {
    const before = build(10);
    const after = before.replace(4, group(99));
    expect(after[4].id).toBe("g99");
    expect(before[4].id).toBe("g4");
    expect(after).not.toBe(before);
  });
});
