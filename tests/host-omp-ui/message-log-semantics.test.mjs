import { describe, test, expect } from "bun:test";

import { MessageLog } from "../../host-omp-ui/web/src/protocol/message-log.ts";

// The sequence has to answer the list operations the renderer and the protocol
// code already call on it. These cases compare it against the array it was
// built from, so a divergence shows up as a wrong list rather than as a
// secondary symptom somewhere downstream.

const mk = (n) =>
  Array.from({ length: n }, (_, index) => ({
    id: `m${index}`,
    role: "assistant",
    blocks: [{ type: "text", text: String(index) }],
  }));

const ids = (messages) => messages.map((message) => message.id);

describe("slice matches Array.prototype.slice", () => {
  const base = mk(40);
  const log = MessageLog.from(base);

  const cases = [
    [5, 9],
    [0, 0],
    [0, 3],
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
      expect(ids(log.slice(from, to))).toEqual(ids(base.slice(from, to)));
    });
  }

  test("a non-numeric bound is zero, not the whole list", () => {
    // `Math.min(length, NaN)` is NaN, and a loop bounded by NaN runs zero
    // times: the answer was [] — a different list, not a clamped one.
    expect(ids(log.slice(NaN))).toEqual(ids(base.slice(NaN)));
    expect(log.slice(NaN).length).toBe(base.length);
  });
});

describe("indexOf matches Array.prototype.indexOf", () => {
  const base = mk(40);
  const log = MessageLog.from(base);

  for (const from of [0, 1, 39, 40, 100, -1, -2, -100, NaN]) {
    test(`fromIndex ${String(from)}`, () => {
      expect(log.indexOf(base[0], from)).toBe(base.indexOf(base[0], from));
      expect(log.indexOf(base[39], from)).toBe(base.indexOf(base[39], from));
    });
  }

  test("a negative start counts from the end", () => {
    // `index >= fromIndex` treated every negative start as "from the head", so
    // a head element answered 0 where an array answers -1.
    expect(log.indexOf(base[0], -1)).toBe(-1);
    expect(log.indexOf(base[38], -2)).toBe(38);
    expect(log.indexOf(base[0], -1)).toBe(base.indexOf(base[0], -1));
  });
});

describe("a version is immutable", () => {
  test("writing through an index fails at the call site", () => {
    const v1 = MessageLog.from(mk(6));
    // Before, the write landed an ordinary own property while reads kept
    // answering from `at()`, so the caller believed the message had changed and
    // nothing had. Silence is the worst outcome for a write.
    expect(() => {
      v1[1] = { id: "hack", role: "assistant", blocks: [] };
    }).toThrow(TypeError);
    expect(v1[1].id).toBe("m1");
  });

  test("a derived version leaves the one it came from untouched", () => {
    const v1 = MessageLog.from(mk(6));
    const v2 = v1.replace(2, { id: "x2", role: "assistant", blocks: [] });
    expect(v2[2].id).toBe("x2");
    expect(v1[2].id).toBe("m2");
    expect(v2).not.toBe(v1);
  });
});

describe("provenance", () => {
  test("the earliest change on a multi-step path answers", () => {
    const root = MessageLog.from(mk(10));
    const chained = root
      .replace(3, { id: "c3", role: "assistant", blocks: [] })
      .replace(7, { id: "c7", role: "assistant", blocks: [] })
      .replace(1, { id: "c1", role: "assistant", blocks: [] });
    // The answer is the earliest of the three, not the newest one.
    expect(chained.diffFrom(root)).toBe(1);
    expect(chained.diffFrom(chained)).toBe(chained.length);
  });

  test("an ancestor past the retained window answers conservatively", () => {
    const root = MessageLog.from(mk(20));
    let latest = root;
    for (let step = 0; step < 12; step += 1) {
      latest = latest.replace(step, { id: `w${step}`, role: "assistant", blocks: [] });
    }
    // Outside the bounded lineage nothing can be proven, so the caller is told
    // to regroup rather than being handed a prefix it cannot verify.
    expect(latest.diffFrom(root)).toBe(0);
    // The newest step is still exact.
    const parentAnswer = latest.diffFrom(latest);
    expect(parentAnswer).toBe(latest.length);
  });
});

describe("tree depth", () => {
  test("reads stay correct while growing past a level boundary", () => {
    // 32 is the capacity of a one-level tree and 1024 of a two-level one, so
    // this crosses both. It is a functional check of the addressing, not a
    // measure of speed.
    let big = MessageLog.empty();
    for (let index = 0; index < 1026; index += 1) {
      big = big.append({ id: `b${index}`, role: "assistant", blocks: [] });
    }
    expect(big.length).toBe(1026);
    for (const index of [0, 31, 32, 33, 1023, 1024, 1025]) {
      expect(big[index].id).toBe(`b${index}`);
    }
    expect(big[1026]).toBeUndefined();
    expect(ids(big.slice(-2))).toEqual(["b1024", "b1025"]);
  });
});
