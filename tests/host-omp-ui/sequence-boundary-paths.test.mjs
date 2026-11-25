import { describe, test, expect } from "bun:test";

// The state holds a persistent sequence, but two paths still work on a plain
// array: the boundary reducer clones into an array so it can write positions,
// and a session switch resets to an empty sequence. Both must hand back a
// sequence, or the next positional read returns undefined and the conversation
// silently stops updating.
//
// These cases drive the real reducers end to end: a boundary event, then a
// positional read, then a stream frame on top of the result.

const STORE = "../../host-omp-ui/web/src/protocol/store.ts";

function frame(messages, overrides = {}) {
  return {
    type: "snapshot",
    session: { id: "s1", title: "Session 1", cwd: "/tmp/work" },
    messages,
    streaming: true,
    todos: [],
    queue: { steering: [], followUp: [] },
    models: [],
    thinkingLevel: "high",
    modes: { plan: "inactive" },
    usage: { tokens: 1, contextWindow: 10, percent: 1 },
    draft: { rev: 1, text: "", cursor: 0 },
    pendingInteractions: [],
    surface: { sf: "s:web", s: 1, ops: [] },
    notifications: [],
    fenceStatus: "live",
    sessions: [{ id: "s1", title: "Session 1" }],
    artifacts: [],
    ...overrides,
  };
}

const conversation = [
  {
    id: "u1",
    role: "user",
    attribution: "user",
    blocks: [{ type: "text", text: "first question" }],
  },
  { id: "a1", role: "assistant", blocks: [{ type: "text", text: "one" }] },
];

async function start() {
  const store = await import(STORE);
  const log = await import("../../host-omp-ui/web/src/protocol/message-log.ts");
  const state = store.reduceWebState(store.createInitialWebState(), frame(conversation));
  return { ...store, MessageLog: log.MessageLog, state };
}

describe("a session switch", () => {
  test("resets to an empty sequence, not an empty array", async () => {
    const { reduceWebState, state, MessageLog } = await start();

    const selected = reduceWebState(state, {
      type: "session.select",
      sessionId: "s2",
    });

    expect(selected.liveSession.messages.length).toBe(0);
    expect(selected.messages).toBe(selected.liveSession.messages);
    // The value must still be a sequence: a later frame replaces a position on
    // it, and a plain array would accept the write and lose structural sharing
    // without any error.
    expect(selected.liveSession.messages instanceof MessageLog).toBe(true);
    expect(typeof selected.liveSession.messages.replace).toBe("function");
    expect([...selected.liveSession.messages]).toEqual([]);
  });

  test("a frame after the switch reads positions normally", async () => {
    const { reduceWebState, state } = await start();

    const selected = reduceWebState(state, {
      type: "session.select",
      sessionId: "s2",
    });
    const seeded = reduceWebState(selected, frame(conversation));

    expect(seeded.liveSession.messages.length).toBe(2);
    expect(seeded.liveSession.messages[0].blocks[0].text).toBe("first question");
    expect(seeded.liveSession.messages[1].id).toBe("a1");

    // And a stream frame lands on it.
    const streamed = reduceWebState(seeded, {
      type: "transcript.delta",
      seq: 2,
      kind: "text_delta",
      messageId: "a1",
      blockIndex: 0,
      delta: "!",
    });
    expect(streamed.liveSession.messages[1].blocks[0].text).toBe("one!");
  });
});

describe("a boundary event that clones into an array", () => {
  test("message_start hands back a sequence the next frame can replace on", async () => {
    const { reduceWebState, state, MessageLog } = await start();

    const boundary = reduceWebState(state, {
      type: "transcript.delta",
      seq: 2,
      kind: "message_start",
      message: {
        id: "a2",
        role: "assistant",
        blocks: [{ type: "text", text: "two" }],
      },
    });

    // The boundary pass mutated a plain array; what it published must be a
    // sequence again, or every later positional write would go to an object
    // that is not the state's history.
    expect(boundary.liveSession.messages instanceof MessageLog).toBe(true);
    expect(boundary.liveSession.messages.length).toBe(3);
    expect(boundary.liveSession.messages[2].id).toBe("a2");

    const streamed = reduceWebState(boundary, {
      type: "transcript.delta",
      seq: 3,
      kind: "text_delta",
      messageId: "a2",
      blockIndex: 0,
      delta: "!",
    });
    expect(streamed.liveSession.messages[2].blocks[0].text).toBe("two!");
    // History before the boundary is untouched.
    expect(streamed.liveSession.messages[0].blocks[0].text).toBe("first question");
  });

  test("the boundary pass does not rewrite the state it was given", async () => {
    const { reduceWebState, state } = await start();

    const before = state.liveSession.messages;
    const firstText = before[0].blocks[0].text;

    reduceWebState(state, {
      type: "transcript.delta",
      seq: 2,
      kind: "message_start",
      message: { id: "a2", role: "assistant", blocks: [{ type: "text", text: "two" }] },
    });

    // The clone is a copy: streaming messages were duplicated before any write,
    // and non-streaming ones kept their identity without being mutated.
    expect(before.length).toBe(2);
    expect(before[0].blocks[0].text).toBe(firstText);
  });
});

describe("both views of the sequence", () => {
  test("state.messages and state.liveSession.messages are the same value", async () => {
    const { reduceWebState, state } = await start();
    // Consumers read either one, and the grouping cache compares identities. Two
    // different values holding equal messages would defeat both.
    expect(state.messages).toBe(state.liveSession.messages);

    const boundary = reduceWebState(state, {
      type: "transcript.delta",
      seq: 2,
      kind: "message_start",
      message: { id: "a2", role: "assistant", blocks: [{ type: "text", text: "two" }] },
    });
    expect(boundary.messages).toBe(boundary.liveSession.messages);
  });
});
