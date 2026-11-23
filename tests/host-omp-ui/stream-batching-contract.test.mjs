import { describe, expect, test } from "bun:test";
import {
  createInitialWebState,
  reduceWebState,
} from "../../host-omp-ui/web/src/protocol/store.ts";
import { createStreamBatcher } from "../../host-omp-ui/web/src/protocol/stream-batcher.ts";

function snapshot(messages) {
  return {
    type: "snapshot",
    session: { id: "session-1" },
    messages,
    streaming: false,
  };
}

function textDelta(messageId, delta, blockIndex = 0) {
  return {
    type: "transcript.delta",
    kind: "text_delta",
    messageId,
    blockIndex,
    delta,
  };
}

function manualScheduler() {
  const scheduled = [];
  return {
    schedule(callback) {
      scheduled.push(callback);
      return () => {
        const index = scheduled.indexOf(callback);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
    get pending() {
      return scheduled.length;
    },
    runNext() {
      const callback = scheduled.shift();
      expect(callback).toBeFunction();
      callback();
    },
  };
}

describe("stream frame batching", () => {
  test("consecutive text deltas for the same message and block merge before flush", () => {
    const scheduler = manualScheduler();
    const flushed = [];
    const batcher = createStreamBatcher({
      schedule: scheduler.schedule,
      flush: (frames) => flushed.push(frames),
    });

    batcher.push(textDelta("m1", "a"));
    batcher.push(textDelta("m1", "b"));
    batcher.push(textDelta("m1", "c"));

    expect(flushed).toEqual([]);
    expect(scheduler.pending).toBe(1);

    scheduler.runNext();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(1);
    expect(flushed[0][0]).toMatchObject({
      type: "transcript.delta",
      kind: "text_delta",
      messageId: "m1",
      blockIndex: 0,
      delta: "abc",
    });
    expect(scheduler.pending).toBe(0);
  });

  test("different message ids, blocks, or delta kinds are not merged", () => {
    const scheduler = manualScheduler();
    const flushed = [];
    const batcher = createStreamBatcher({
      schedule: scheduler.schedule,
      flush: (frames) => flushed.push(frames),
    });

    batcher.push(textDelta("m1", "a"));
    batcher.push(textDelta("m1", "b", 1));
    batcher.push({
      type: "transcript.delta",
      kind: "thinking_delta",
      messageId: "m1",
      blockIndex: 0,
      delta: "c",
    });
    batcher.push(textDelta("m2", "d"));

    scheduler.runNext();

    expect(flushed).toHaveLength(1);
    expect(flushed[0].map((frame) => frame.delta)).toEqual(["a", "b", "c", "d"]);
  });

  test("terminal frames flush pending deltas immediately and in order", () => {
    const scheduler = manualScheduler();
    const flushed = [];
    const batcher = createStreamBatcher({
      schedule: scheduler.schedule,
      flush: (frames) => flushed.push(frames),
    });

    batcher.push(textDelta("m1", "a"));
    batcher.push(textDelta("m1", "b"));
    batcher.push({
      type: "transcript.delta",
      kind: "message_end",
      messageId: "m1",
      message: { id: "m1", role: "assistant", blocks: [{ type: "text", text: "ab" }] },
    });

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
    expect(flushed[0][0]).toMatchObject({ kind: "text_delta", delta: "ab" });
    expect(flushed[0][1]).toMatchObject({ kind: "message_end", messageId: "m1" });
    expect(scheduler.pending).toBe(0);
    expect(flushed).toHaveLength(1);
  });

  test("flushNow drains without waiting for the scheduler", () => {
    const scheduler = manualScheduler();
    const flushed = [];
    const batcher = createStreamBatcher({
      schedule: scheduler.schedule,
      flush: (frames) => flushed.push(frames),
    });

    batcher.push(textDelta("m1", "a"));
    batcher.flushNow();

    expect(flushed).toHaveLength(1);
    expect(flushed[0][0]).toMatchObject({ delta: "a" });
    expect(scheduler.pending).toBe(0);
  });
});

describe("delta structural sharing", () => {
  test("a text delta replaces only the active message and its blocks", () => {
    const initial = reduceWebState(
      createInitialWebState(),
      snapshot([
        {
          id: "m1",
          role: "assistant",
          blocks: [{ type: "text", text: "one" }],
          streaming: false,
        },
        {
          id: "m2",
          role: "assistant",
          blocks: [{ type: "text", text: "two" }],
          streaming: false,
        },
        {
          id: "m3",
          role: "assistant",
          blocks: [{ type: "text", text: "three" }],
          streaming: false,
        },
      ]),
    );

    const before = initial.liveSession.messages;
    const next = reduceWebState(initial, textDelta("m3", " and four"));
    const after = next.liveSession.messages;

    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(after[2].blocks).not.toBe(before[2].blocks);
    expect(after[0].blocks).toBe(before[0].blocks);
    expect(after[1].blocks).toBe(before[1].blocks);
    expect(after[2].blocks[0]).toMatchObject({ type: "text", text: "three and four" });
    expect(after[2].streaming).toBe(true);
    expect(after[0].streaming).toBe(false);
    expect(after[1].streaming).toBe(false);
  });

  test("consecutive deltas keep untouched messages reference-stable across updates", () => {
    let state = reduceWebState(
      createInitialWebState(),
      snapshot([
        { id: "m1", role: "assistant", blocks: [{ type: "text", text: "one" }] },
        { id: "m2", role: "assistant", blocks: [{ type: "text", text: "two" }] },
      ]),
    );

    const firstMessage = state.liveSession.messages[0];
    state = reduceWebState(state, textDelta("m2", "!"));
    state = reduceWebState(state, textDelta("m2", "?"));

    expect(state.liveSession.messages[0]).toBe(firstMessage);
    expect(state.liveSession.messages[1].blocks[0]).toMatchObject({
      type: "text",
      text: "two!?",
    });
  });
});
