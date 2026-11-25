import { describe, expect, test } from "bun:test";
import { fitSnapshot } from "../../host-omp-ui/src/station/domain/snapshot-fit.mjs";

function message(id, chars) {
  return { id, role: "assistant", blocks: [], text: "x".repeat(chars) };
}

function doc(messages) {
  return {
    messages,
    toolExecutions: {},
    artifacts: [],
    history: { hasMore: false },
    surface: {},
    sessions: [],
    widgets: [],
  };
}

describe("fitSnapshot trimming", () => {
  test("multi-round trim subtracts each dropped prefix item exactly once", () => {
    // 4 small + 4 large messages: only a correct running total reaches the
    // 8 MiB budget on the second halving round. Re-subtracting the already
    // dropped head would over-count the remaining document and cut one
    // message too many.
    const messages = [
      message("m0", 500_000),
      message("m1", 500_000),
      message("m2", 500_000),
      message("m3", 500_000),
      message("m4", 3_000_000),
      message("m5", 3_000_000),
      message("m6", 3_000_000),
      message("m7", 3_000_000),
    ];
    const shaped = fitSnapshot(doc(messages));

    expect(shaped.messages.map((item) => item.id)).toEqual(["m6", "m7"]);
    expect(shaped.history.hasMore).toBe(true);
    expect(shaped.history.oldestId).toBe("m6");
  });

  test("a document that already fits is left untouched", () => {
    const messages = [message("m0", 10), message("m1", 10)];
    const input = doc(messages);
    const shaped = fitSnapshot(input);

    expect(shaped).toBe(input);
    expect(shaped.messages).toBe(messages);
    expect(shaped.history.hasMore).toBe(false);
    expect(shaped.history.oldestId).toBe("m0");
  });

  test("tool executions are trimmed by the same prefix rule", () => {
    const toolExecutions = {};
    for (let index = 0; index < 8; index += 1) {
      toolExecutions[`t${index}`] = { result: "y".repeat(3_000_000) };
    }
    const input = doc([message("m0", 10)]);
    input.toolExecutions = toolExecutions;
    const shaped = fitSnapshot(input);

    // 24 MB drops to 12 MB after one round, then to 6 MB after the second.
    expect(Object.keys(shaped.toolExecutions)).toEqual(["t6", "t7"]);
  });

  test("repeated frames over the same shaped messages trim identically", () => {
    // The station shapes a message once and then hands the same object to every
    // later frame. Measuring it once must not change which window survives: a
    // stale or missing measurement would trim a different number of messages.
    const messages = [
      message("m0", 100),
      message("m1", 4_000_000),
      message("m2", 4_000_000),
      message("m3", 4_000_000),
    ];
    const first = fitSnapshot(doc(messages)).messages.map((item) => item.id);
    const second = fitSnapshot(doc(messages)).messages.map((item) => item.id);
    expect(second).toEqual(first);
    expect(first).toEqual(["m2", "m3"]);
  });
});
