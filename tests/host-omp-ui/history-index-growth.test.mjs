import { describe, expect, test } from "bun:test";

import {
  buildHistoryIndex,
  extendHistoryIndex,
  reconstructRange,
} from "../../host-omp-ui/src/station/domain/transcript-model.mjs";
import { createUiBridgeStation } from "../../host-omp-ui/src/station/ui-bridge-station.mjs";

// The host appends to its own branch array while the session runs. The index a
// frame uses used to be rebuilt over the whole branch on every append — tens of
// milliseconds per frame on a long session, to learn one new position. It now
// reads only the tail.
//
// The contract is that an extended index answers exactly what a full build
// answers, for every map. That is the only thing the station relies on, and the
// cases below are the ones where a tail-only pass could disagree: a repeated id,
// an entry that shows nothing, a result whose call id already appeared, and an
// array that is replaced rather than grown.

const user = (id, text) => ({
  type: "message",
  id,
  message: { role: "user", content: [{ type: "text", text }] },
});

const assistant = (id, blocks) => ({
  type: "message",
  id,
  message: { role: "assistant", content: blocks },
});

const toolResult = (id, toolCallId, text) => ({
  type: "message",
  id,
  message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }] },
});

const call = (id) => ({ type: "toolCall", id, name: "bash", args: { command: "ls" } });

/** Both maps, compared the way a reader would see them. */
function sameAnswer(a, b) {
  expect([...a.idIndex].sort()).toEqual([...b.idIndex].sort());
  expect([...a.idOrdinals].sort()).toEqual([...b.idOrdinals].sort());
  expect([...a.resultIndex].sort()).toEqual([...b.resultIndex].sort());
  expect(a.entryOfMessage).toEqual(b.entryOfMessage);
}

describe("an index extended over an appended branch", () => {
  test("answers what a full build answers, entry by entry", () => {
    const entries = [
      user("u1", "one"),
      assistant("a1", [call("c1")]),
      toolResult("r1", "c1", "out"),
    ];
    let index = buildHistoryIndex(entries);

    for (const next of [
      user("u2", "two"),
      // A repeated id: the first occurrence must keep the name.
      user("u1", "again"),
      // An entry that shows nothing: it takes a position and no ordinal.
      { type: "message", id: "blank" },
      assistant("a2", [call("c2")]),
      // A second result for a call id that already has one.
      toolResult("r2", "c1", "final"),
      { id: "x1", type: "custom_message", customType: "note", content: "hi" },
      { id: "b1", type: "branch_summary", summary: "branch" },
      { id: "k1", type: "compaction", summary: "compact" },
    ]) {
      entries.push(next);
      index = extendHistoryIndex(index, entries);
      sameAnswer(index, buildHistoryIndex(entries));
    }
  });

  test("a frame after an append shows the new message and its page resolves", () => {
    const entries = Array.from({ length: 400 }, (_, i) => user(`u${i}`, `t${i}`));
    const station = createUiBridgeStation({ capabilities: { dispatch() {} } });
    station.onSessionHydrate({ id: "s", cwd: "/tmp" }, entries);

    for (let k = 0; k < 60; k += 1) entries.push(user(`n${k}`, "new"));

    expect(station.snapshot(2).messages.map((m) => m.id)).toEqual(["n58", "n59"]);
    const page = station.historyPage({ before: "n59", limit: 5 });
    expect(page.ok).toBe(true);
    expect(page.messages.map((m) => m.id)).toEqual(["n54", "n55", "n56", "n57", "n58"]);
  });

  test("a page inside the old branch still resolves after growth", () => {
    const entries = Array.from({ length: 400 }, (_, i) => user(`u${i}`, `t${i}`));
    const station = createUiBridgeStation({ capabilities: { dispatch() {} } });
    station.onSessionHydrate({ id: "s", cwd: "/tmp" }, entries);
    entries.push(user("n0", "new"));

    const page = station.historyPage({ before: "u300", limit: 5 });
    expect(page.ok).toBe(true);
    expect(page.messages.map((m) => m.id)).toEqual(["u295", "u296", "u297", "u298", "u299"]);
  });
});

describe("an index that is not grown", () => {
  test("a replaced array is built from scratch", () => {
    const first = [user("u1", "one"), user("u2", "two")];
    const index = buildHistoryIndex(first);

    const replaced = [user("k1", "other")];
    const rebuilt = extendHistoryIndex(index, replaced);

    expect(rebuilt.source).toBe(replaced);
    sameAnswer(rebuilt, buildHistoryIndex(replaced));
    expect(rebuilt.idIndex.has("u1")).toBe(false);
  });

  test("a shortened array does not keep entries that are gone", () => {
    const entries = [user("u1", "one"), user("u2", "two"), user("u3", "three")];
    const index = buildHistoryIndex(entries);

    entries.length = 1;
    const rebuilt = extendHistoryIndex(index, entries);

    expect(rebuilt.entryCount).toBe(1);
    sameAnswer(rebuilt, buildHistoryIndex(entries));
    expect(rebuilt.idOrdinals.has("u3")).toBe(false);
  });

  test("an unchanged array answers with the index it was given", () => {
    const entries = [user("u1", "one")];
    const index = buildHistoryIndex(entries);
    expect(extendHistoryIndex(index, entries)).toBe(index);
  });

  test("the previous index keeps describing the branch it was built for", () => {
    const entries = [user("u1", "one")];
    const index = buildHistoryIndex(entries);
    entries.push(user("u2", "two"));
    extendHistoryIndex(index, entries);

    // A holder of the old object still sees its own length, so it rebuilds
    // rather than reading a position past what it validated.
    expect(index.entryCount).toBe(1);
  });
});

describe("the cost of growth", () => {
  test("one appended entry does not cost a tour of the branch", () => {
    const entries = Array.from({ length: 40000 }, (_, i) => user(`u${i}`, "x".repeat(40)));
    let index = buildHistoryIndex(entries);

    const started = performance.now();
    for (let k = 0; k < 200; k += 1) {
      entries.push(user(`n${k}`, "y"));
      index = extendHistoryIndex(index, entries);
    }
    const elapsed = performance.now() - started;

    expect(index.entryOfMessage).toHaveLength(entries.length);
    // A per-entry tour on each of 200 appends over 40000 entries would take far
    // longer; the bound is loose on purpose, it guards the shape.
    expect(elapsed).toBeLessThan(200);
  });
});
