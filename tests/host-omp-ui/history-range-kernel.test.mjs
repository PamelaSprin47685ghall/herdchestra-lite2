import { describe, expect, test } from "bun:test";

import {
  buildHistoryIndex,
  messageOrdinalOfId,
  reconstructRange,
  reconstructTranscriptFromEntries,
} from "../../host-omp-ui/src/station/domain/transcript-model.mjs";

// The range kernel exists so a long session can build one page of messages
// without holding a display copy of every entry. Its contract is exact: the
// messages it produces for a range must be the messages the whole-transcript
// rebuild produces for that range, including a tool call whose result lives on
// another page. The equality below is the whole test plan, because it is the
// only thing the station will rely on.

const text = (value) => [{ type: "text", text: value }];

const user = (id, value) => ({
  id,
  type: "message",
  timestamp: 1,
  message: { role: "user", content: text(value) },
});

const assistant = (id, blocks) => ({
  id,
  type: "message",
  timestamp: 2,
  message: { role: "assistant", content: blocks },
});

const toolResult = (id, toolCallId, value, isError = false) => ({
  id,
  type: "message",
  timestamp: 3,
  message: { role: "toolResult", toolCallId, toolName: "bash", isError, content: text(value) },
});

const toolCall = (id) => ({ type: "toolCall", id, name: "bash", args: { command: "ls" } });

/** A branch with a cross-page result, duplicates, and every special entry. */
function branch() {
  return [
    user("u1", "ask"),
    assistant("a1", [toolCall("c1")]),
    // The result for c1 is far from its call.
    user("u2", "next"),
    { id: "x1", type: "custom_message", customType: "note", content: "custom text", timestamp: 4 },
    assistant("a2", [toolCall("c2")]),
    { id: "b1", type: "branch_summary", summary: "branch said", timestamp: 5 },
    { id: "k1", type: "compaction", summary: "compacted", timestamp: 6 },
    toolResult("r2", "c2", "second output"),
    // A repeated id: the first occurrence is the one a cursor resolves.
    user("u1", "ask again"),
    // A repeated call id: the whole rebuild pairs the last result.
    toolResult("r1a", "c1", "first output"),
    toolResult("r1b", "c1", "final output", true),
  ];
}

describe("the range rebuild", () => {
  test("answers the whole branch with every projection in place", () => {
    const entries = branch();
    const page = reconstructRange(entries, 0, entries.length);

    expect(page).toHaveLength(11);
    const call = page[1].blocks.find((block) => block.type === "toolCall");
    expect(call.resultText).toBe("final output");
    expect(call.isError).toBe(true);
    expect(page[3].text).toBe("custom text");
    expect(page[5].summary).toBe("branch said");
    expect(page[6].summary).toBe("compacted");
  });

  test("pairs a tool call with a result on another page", () => {
    const entries = branch();
    const page = reconstructRange(entries, 0, 2);
    const call = page[1].blocks.find((block) => block.type === "toolCall");

    // The call is on this page, its result is not — and the last result for the
    // id wins, as it does in the whole-transcript pass.
    expect(call.resultText).toBe("final output");
    expect(call.isError).toBe(true);
    expect(call.result).toEqual(text("final output"));
  });

  test("every window agrees with the whole rebuild", () => {
    const entries = branch();
    const whole = reconstructTranscriptFromEntries(entries);
    for (let from = 0; from <= entries.length; from += 1) {
      for (let to = from; to <= entries.length; to += 1) {
        expect(reconstructRange(entries, from, to)).toEqual(whole.slice(from, to));
      }
    }
  });

  test("keeps the special entries and the duplicate id in order", () => {
    const entries = branch();
    const page = reconstructRange(entries, 0, entries.length);
    expect(page.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "x1",
      "a2",
      "b1",
      "k1",
      "r2",
      "u1",
      "r1a",
      "r1b",
    ]);
    expect(page[3].role).toBe("custom");
    expect(page[5].role).toBe("branchSummary");
    expect(page[6].role).toBe("compactionSummary");
  });

  test("a range past the end is empty, not an error", () => {
    const entries = branch();
    expect(reconstructRange(entries, entries.length, entries.length + 5)).toEqual([]);
    expect(reconstructRange(entries, 99, 120)).toEqual([]);
    expect(reconstructRange([], 0, 0)).toEqual([]);
    expect(reconstructRange(null, 0, 3)).toEqual([]);
  });
});

describe("the history index", () => {
  test("points at the first entry for an id and the last result for a call", () => {
    const entries = branch();
    const { idIndex, resultIndex } = buildHistoryIndex(entries);

    expect(idIndex.get("u1")).toBe(0);
    expect(idIndex.get("k1")).toBe(6);
    expect(resultIndex.get("c1")).toBe(10);
    expect(resultIndex.get("c2")).toBe(7);
    expect(resultIndex.get("missing")).toBeUndefined();
  });

  test("skips entries that carry no id", () => {
    const entries = [{ type: "message", message: { role: "user", content: text("x") } }];
    const { idIndex } = buildHistoryIndex(entries);
    expect(idIndex.size).toBe(0);
  });

  test("a supplied index answers what a fresh one answers", () => {
    const entries = branch();
    const shared = buildHistoryIndex(entries);
    for (const [from, to] of [[0, 3], [3, 8], [7, 11], [2, 2]]) {
      expect(reconstructRange(entries, from, to, shared)).toEqual(
        reconstructRange(entries, from, to),
      );
    }
  });
});

describe("the cost of a page", () => {
  test("does not grow with the entries outside it", () => {
    const filler = Array.from({ length: 4000 }, (_, index) => user(`f${index}`, "x".repeat(50)));
    const entries = [...filler, ...branch()];

    const started = performance.now();
    let page;
    for (let repeat = 0; repeat < 50; repeat += 1) {
      page = reconstructRange(entries, entries.length - 3, entries.length);
    }
    const elapsed = performance.now() - started;

    expect(page).toHaveLength(3);
    // A per-entry cost over 4000 entries on every page would take far longer
    // than this; the assertion is loose on purpose, it guards the shape.
    expect(elapsed).toBeLessThan(200);
  });
});

describe("two calls that name the same result", () => {
  // A retried call, or two blocks reusing an id, both pair with the one result
  // the whole-transcript pass picks (the last one for that call id). That pass
  // assigns one message object, so every call's `result` blocks are the same
  // array; a page that rebuilt the entry per call would hand out equal contents
  // with different identities, and would project the same entry twice.
  const twoCalls = () => [
    assistant("a1", [toolCall("c1")]),
    user("u2", "middle"),
    assistant("a2", [toolCall("c1")]),
    toolResult("r1", "c1", "shared output"),
  ];

  test("share one blocks array when the result is on the page", () => {
    const entries = twoCalls();
    const page = reconstructRange(entries, 0, entries.length);
    const first = page[0].blocks.find((block) => block.type === "toolCall");
    const second = page[2].blocks.find((block) => block.type === "toolCall");
    const result = page[3];

    expect(first.result).toBe(result.blocks);
    expect(second.result).toBe(result.blocks);
    expect(first.result).toBe(second.result);
  });

  test("share one blocks array when the result is on another page", () => {
    const entries = twoCalls();
    const page = reconstructRange(entries, 0, 3);
    const first = page[0].blocks.find((block) => block.type === "toolCall");
    const second = page[2].blocks.find((block) => block.type === "toolCall");

    expect(first.resultText).toBe("shared output");
    expect(second.resultText).toBe("shared output");
    // Built once, not once per call: the same array for both.
    expect(first.result).toBe(second.result);
  });

  test("the whole rebuild keeps the same identity too", () => {
    const entries = twoCalls();
    const whole = reconstructTranscriptFromEntries(entries);
    const first = whole[0].blocks.find((block) => block.type === "toolCall");
    expect(first.result).toBe(whole[3].blocks);
  });
});

describe("an id that belongs to an entry with nothing to show", () => {
  // `idIndex` keeps every entry's id, because that is the only way to answer
  // "does this cursor exist at all". An entry that projects to no message has an
  // id but no ordinal, and the kernel must say so — -1, the same answer the old
  // `findIndex` gave when the id was absent from the message array.
  const withHiddenId = () => [
    user("u1", "ask"),
    { id: "hidden", type: "message", timestamp: 9 },
    user("u2", "next"),
  ];

  test("resolves to no message ordinal", () => {
    const entries = withHiddenId();
    const index = buildHistoryIndex(entries);
    expect(index.idIndex.has("hidden")).toBe(true);
    expect(messageOrdinalOfId(index, "hidden")).toBe(-1);
    expect(messageOrdinalOfId(index, "u2")).toBe(1);
    expect(messageOrdinalOfId(index, "absent")).toBe(-1);
  });

  test("a page bounded by an ordinal still excludes it", () => {
    const entries = withHiddenId();
    const page = reconstructRange(entries, 0, 2);
    expect(page.map((message) => message.id)).toEqual(["u1", "u2"]);
  });
});

describe("entries that project to nothing", () => {
  // A branch can hold entries the model does not display: a message entry with
  // no payload, or a type this release does not know. They take an entry
  // position but no message position, so a range addressed by entry index would
  // drift — the fix is that the range is addressed by message ordinal and the
  // index carries the entry position of each message.
  const withBlanks = () => {
    const entries = branch();
    entries.splice(2, 0, { id: "empty", type: "message", timestamp: 9 });
    entries.splice(5, 0, { id: "future", type: "something_new", timestamp: 9 });
    return entries;
  };

  test("the index skips them and keeps the message order", () => {
    const entries = withBlanks();
    const { entryOfMessage } = buildHistoryIndex(entries);
    const whole = reconstructTranscriptFromEntries(entries);
    expect(entryOfMessage).toHaveLength(whole.length);
    // No entry position is repeated, and they all point at real entries.
    expect(new Set(entryOfMessage).size).toBe(entryOfMessage.length);
    for (const at of entryOfMessage) expect(entries[at]).toBeDefined();
  });

  test("every message range still matches the whole rebuild", () => {
    const entries = withBlanks();
    const whole = reconstructTranscriptFromEntries(entries);
    for (let from = 0; from <= whole.length; from += 1) {
      for (let to = from; to <= whole.length; to += 1) {
        expect(reconstructRange(entries, from, to)).toEqual(whole.slice(from, to));
      }
    }
  });

  test("the predicate agrees with the projection for every entry", () => {
    const entries = withBlanks();
    const { entryOfMessage } = buildHistoryIndex(entries);
    const whole = reconstructTranscriptFromEntries(entries);
    // Every indexed entry projects, and to the message at that ordinal. Reading
    // one ordinal at a time is what proves the pairing between the index and the
    // projection, not just their counts.
    for (let ordinal = 0; ordinal < entryOfMessage.length; ordinal += 1) {
      const page = reconstructRange(entries, ordinal, ordinal + 1);
      expect(page).toHaveLength(1);
      expect(page[0].id).toBe(entries[entryOfMessage[ordinal]].id);
    }
    // Every entry that is not indexed contributes nothing: the whole rebuild
    // holds exactly the indexed entries' ids, in the same order.
    expect(whole.map((message) => message.id)).toEqual(
      entryOfMessage.map((at) => entries[at].id),
    );
    // And the two blanks really are the unindexed positions.
    const blankAt = entries.findIndex((entry) => entry?.id === "empty");
    const futureAt = entries.findIndex((entry) => entry?.id === "future");
    expect(entryOfMessage).not.toContain(blankAt);
    expect(entryOfMessage).not.toContain(futureAt);
  });
});

describe("the two index spaces and the identity a page keeps", () => {
  test("a page's tool result is the object the call points at", () => {
    const entries = branch();
    const page = reconstructRange(entries, 0, entries.length);
    const call = page[1].blocks.find((block) => block.type === "toolCall");
    const result = page.find((message) => message.id === "r1b");
    // Same array, not an equal copy: the whole-transcript pass produced this
    // alias, and a reader may rely on it.
    expect(call.result).toBe(result.blocks);
  });

  test("an id resolves to its first message ordinal, across the two spaces", () => {
    const entries = branch();
    const index = buildHistoryIndex(entries);
    expect(messageOrdinalOfId(index, "u1")).toBe(0);
    expect(messageOrdinalOfId(index, "k1")).toBe(6);
    expect(messageOrdinalOfId(index, "nope")).toBe(-1);
    // The entry position is not the message ordinal once an entry is skipped.
    const withBlank = branch();
    withBlank.splice(1, 0, { id: "blank", type: "message", timestamp: 0 });
    const shifted = buildHistoryIndex(withBlank);
    expect(shifted.idIndex.get("a1")).toBe(2);
    expect(messageOrdinalOfId(shifted, "a1")).toBe(1);
  });

  test("an index built for another array does not answer for this one", () => {
    const entries = branch();
    const stale = buildHistoryIndex(entries);
    // A longer array: the length check rejects the index.
    const grown = [...entries, user("u99", "later")];
    expect(reconstructRange(grown, grown.length - 1, grown.length, stale)).toEqual(
      reconstructTranscriptFromEntries(grown).slice(-1),
    );
    // A replaced array of the same length: the identity check rejects it.
    const replaced = branch();
    expect(reconstructRange(replaced, 0, 1, stale)).toEqual(
      reconstructTranscriptFromEntries(replaced).slice(0, 1),
    );
  });
});
