import { describe, test, expect } from "bun:test";

// A `toolcall_*` frame is emitted once per argument chunk while an agent
// streams a tool call, so it is the second-highest-frequency stream. It used to
// take the whole-history path — clone every message, scan for the target,
// rebuild the tree — which made a long session pay its own length per chunk.
//
// When the frame names a message that exists, the reducer now replaces one
// position in the persistent vector. These cases pin that the result is the
// same thing a reader sees, and that the paths which cannot be resolved
// positionally still run.

const MODULE = "../../host-omp-ui/web/src/protocol/store.ts";

async function load() {
  return await import(MODULE);
}

function snapshot(overrides = {}) {
  return {
    type: "snapshot",
    session: { id: "s1", title: "Session 1", cwd: "/tmp/work" },
    messages: [],
    streaming: false,
    todos: [],
    queue: { steering: [], followUp: [] },
    models: [{ provider: "p", id: "m1", name: "Model 1" }],
    thinkingLevel: "high",
    modes: { plan: "inactive" },
    ...overrides,
  };
}

const delta = (fields) => ({ type: "transcript.delta", ...fields });

async function start(messages = []) {
  const api = await load();
  return api.reduceWebState(api.createInitialWebState(), snapshot({ messages }));
}

const toolBlocks = (message) =>
  (message.blocks ?? []).filter(
    (block) => block.type === "tool" || block.type === "toolCall",
  );

describe("a tool call streamed into a named message", () => {
  test("accumulates the argument chunks onto one tool block", async () => {
    const api = await load();
    let state = await start();
    state = api.reduceWebState(
      state,
      delta({ kind: "message_start", message: { id: "a1", role: "assistant", blocks: [] } }),
    );

    for (const chunk of ["{\"command\":", "\"ls -la\"", "}"]) {
      state = api.reduceWebState(
        state,
        delta({
          kind: "toolcall_delta",
          messageId: "a1",
          toolCallId: "c1",
          toolName: "bash",
          argsDelta: chunk,
        }),
      );
    }

    expect(state.messages).toHaveLength(1);
    const blocks = toolBlocks(state.messages[0]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].toolCallId).toBe("c1");
    expect(blocks[0].name).toBe("bash");
    expect(blocks[0].status).toBe("running");
    // The accumulated text is the concatenation of every chunk, unchanged.
    expect(state.toolExecutions.c1.argsText).toBe("{\"command\":\"ls -la\"}");
  });

  test("a completed call parses the accumulated arguments", async () => {
    const api = await load();
    let state = await start();
    state = api.reduceWebState(
      state,
      delta({ kind: "message_start", message: { id: "a1", role: "assistant", blocks: [] } }),
    );
    state = api.reduceWebState(
      state,
      delta({
        kind: "toolcall_start",
        messageId: "a1",
        toolCallId: "c1",
        toolName: "bash",
      }),
    );
    state = api.reduceWebState(
      state,
      delta({
        kind: "toolcall_delta",
        messageId: "a1",
        toolCallId: "c1",
        argsDelta: "{\"command\":\"pwd\"}",
      }),
    );
    state = api.reduceWebState(
      state,
      delta({ kind: "toolcall_end", messageId: "a1", toolCallId: "c1" }),
    );

    const execution = state.toolExecutions.c1;
    expect(execution.status).toBe("running");
    // `toolcall_end` clears the streamed text and keeps the parsed object.
    expect(execution.argsText).toBeUndefined();
    expect(execution.args).toEqual({ command: "pwd" });
    expect(toolBlocks(state.messages[0])).toHaveLength(1);
  });

  test("does not copy the messages the frame did not touch", async () => {
    const api = await load();
    let state = await start([
      { id: "u1", role: "user", blocks: [{ type: "text", text: "ask" }] },
    ]);
    state = api.reduceWebState(
      state,
      delta({ kind: "message_start", message: { id: "a1", role: "assistant", blocks: [] } }),
    );
    // Taken after hydration, because the snapshot normalizes what it is given.
    const history = state.messages[0];

    state = api.reduceWebState(
      state,
      delta({
        kind: "toolcall_delta",
        messageId: "a1",
        toolCallId: "c1",
        toolName: "read",
        argsDelta: "{}",
      }),
    );

    // Identity of the untouched prefix is the observable proof that the frame
    // replaced one slot instead of rebuilding the sequence.
    expect(state.messages[0]).toBe(history);
    expect(state.toolExecutions.c1.name).toBe("read");
  });

  test("keeps a streaming flag the message already had", async () => {
    const api = await load();
    let state = await start();
    state = api.reduceWebState(
      state,
      delta({ kind: "message_start", message: { id: "a1", role: "assistant", blocks: [] } }),
    );
    state = api.reduceWebState(
      state,
      delta({
        kind: "toolcall_delta",
        messageId: "a1",
        toolCallId: "c1",
        toolName: "bash",
        argsDelta: "{}",
      }),
    );

    // A tool call arrives inside a running turn; the turn is not over.
    expect(state.streaming).toBe(true);
    expect(state.meta.busy).toBe(true);
    expect(state.messages.filter((message) => message.streaming)).toHaveLength(1);
  });

  test("two calls in the same message each get their own block", async () => {
    const api = await load();
    let state = await start();
    state = api.reduceWebState(
      state,
      delta({ kind: "message_start", message: { id: "a1", role: "assistant", blocks: [] } }),
    );
    for (const id of ["c1", "c2"]) {
      state = api.reduceWebState(
        state,
        delta({
          kind: "toolcall_delta",
          messageId: "a1",
          toolCallId: id,
          toolName: "bash",
          argsDelta: "{}",
        }),
      );
    }

    const blocks = toolBlocks(state.messages[0]);
    expect(blocks.map((block) => block.toolCallId)).toEqual(["c1", "c2"]);
    expect(Object.keys(state.toolExecutions).sort()).toEqual(["c1", "c2"]);
  });
});

describe("a tool call frame that cannot be resolved positionally", () => {
  test("without a message id it still lands on the assistant message", async () => {
    const api = await load();
    let state = await start();
    state = api.reduceWebState(
      state,
      delta({ kind: "message_start", message: { id: "a1", role: "assistant", blocks: [] } }),
    );
    state = api.reduceWebState(
      state,
      delta({
        kind: "toolcall_delta",
        toolCallId: "c1",
        toolName: "bash",
        argsDelta: "{}",
      }),
    );

    // The whole-history path finds the message that holds the tool block, or
    // falls back to the streaming assistant.
    expect(toolBlocks(state.messages[0])[0].toolCallId).toBe("c1");
  });

  test("an id that names no message still attaches through the whole-history path", async () => {
    const api = await load();
    let state = await start([
      { id: "u1", role: "user", blocks: [{ type: "text", text: "ask" }] },
    ]);
    state = api.reduceWebState(
      state,
      delta({
        kind: "toolcall_delta",
        messageId: "missing",
        toolCallId: "c1",
        toolName: "bash",
        argsDelta: "{}",
      }),
    );

    const holder = state.messages.find((message) =>
      toolBlocks(message).some((block) => block.toolCallId === "c1"),
    );
    expect(holder).toBeDefined();
  });

  test("a duplicate message id still edits the message the id names first", async () => {
    const api = await load();
    const first = {
      id: "a1",
      role: "assistant",
      blocks: [],
      streaming: false,
    };
    const second = { ...first, blocks: [] };
    let state = await start([first, second]);
    state = api.reduceWebState(
      state,
      delta({
        kind: "toolcall_delta",
        messageId: "a1",
        toolCallId: "c1",
        toolName: "bash",
        argsDelta: "{}",
      }),
    );

    // Both paths agree here: `find` picks the first, and the position map does
    // too. What matters is that the tool block landed on exactly one of them.
    const holders = state.messages.filter((message) =>
      toolBlocks(message).some((block) => block.toolCallId === "c1"),
    );
    expect(holders).toHaveLength(1);
    expect(state.messages.indexOf(holders[0])).toBe(0);
  });
});
