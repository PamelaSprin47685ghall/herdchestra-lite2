import { describe, test, expect } from "bun:test";

// A stream frame that names no message still has one target: the assistant
// message that is already streaming. The reducer resolves that target and takes
// the positional path, which copies one path through the persistent vector
// instead of cloning the history and rebuilding the tree on every tick.
//
// These cases pin that the resolution changes nothing a reader can see, and that
// the two shapes it cannot resolve safely — no streaming assistant at all, and a
// duplicated id — keep the old whole-history path.

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

async function start(messages = [], overrides = {}) {
  const api = await load();
  return api.reduceWebState(
    api.createInitialWebState(),
    snapshot({ messages, ...overrides }),
  );
}

const textOf = (message) =>
  (message.blocks ?? []).map((block) => block.text ?? "").join("");

describe("a text delta that names no message", () => {
  test("appends to the assistant message that is streaming", async () => {
    let state = await start();
    const api = await load();
    state = api.reduceWebState(
      state,
      delta({
        kind: "message_start",
        message: { id: "a1", role: "assistant", blocks: [] },
      }),
    );

    state = api.reduceWebState(state, delta({ kind: "text_delta", text: "hel" }));
    state = api.reduceWebState(state, delta({ kind: "text_delta", text: "lo" }));

    expect(state.messages).toHaveLength(1);
    expect(textOf(state.messages[0])).toBe("hello");
    expect(state.messages[0].streaming).toBe(true);
  });

  test("leaves exactly one message streaming, as a named frame does", async () => {
    const api = await load();
    let state = await start();
    state = api.reduceWebState(
      state,
      delta({
        kind: "message_start",
        message: { id: "a1", role: "assistant", blocks: [] },
      }),
    );
    state = api.reduceWebState(state, delta({ kind: "text_delta", text: "one" }));

    expect(
      state.messages.filter((message) => message.streaming).map((message) => message.id),
    ).toEqual(["a1"]);
  });

  test("does not copy the history that the frame did not touch", async () => {
    const api = await load();
    let state = await start([{ id: "u1", role: "user", blocks: [{ type: "text", text: "ask" }] }]);
    state = api.reduceWebState(
      state,
      delta({
        kind: "message_start",
        message: { id: "a1", role: "assistant", blocks: [] },
      }),
    );
    // The baseline is taken after hydration, because the snapshot normalizes
    // the messages it is given into its own objects.
    const baseline = state.messages[0];
    state = api.reduceWebState(state, delta({ kind: "text_delta", text: "answer" }));

    // The positional path replaces one slot; the message before it keeps its
    // identity, which is what lets memoized derivations skip the prefix.
    expect(state.messages[0]).toBe(baseline);
    expect(textOf(state.messages[1])).toBe("answer");
  });

  test("still appends to the last assistant when nothing is streaming", async () => {
    const api = await load();
    const settled = {
      id: "a0",
      role: "assistant",
      blocks: [{ type: "text", text: "earlier" }],
      streaming: false,
    };
    let state = await start([settled]);
    state = api.reduceWebState(state, delta({ kind: "text_delta", text: " more" }));

    // No streaming assistant means no id to resolve, so the whole-history path
    // runs — and it marks the message it appended to as streaming.
    expect(state.messages).toHaveLength(1);
    expect(textOf(state.messages[0])).toBe("earlier more");
    expect(state.messages[0].streaming).toBe(true);
  });

  test("a duplicated id keeps the positional lookup off the wrong message", async () => {
    const api = await load();
    const first = {
      id: "a1",
      role: "assistant",
      blocks: [{ type: "text", text: "first" }],
      streaming: false,
    };
    const second = {
      id: "a1",
      role: "assistant",
      blocks: [{ type: "text", text: "second" }],
      streaming: true,
    };
    let state = await start([first, second]);
    state = api.reduceWebState(state, delta({ kind: "text_delta", text: "!" }));

    // The id index answers the first occurrence, so resolving this frame by id
    // would append to "first". The duplicate keeps the path that walks
    // positions, and the streaming message is the one that grows.
    expect(textOf(state.messages[0])).toBe("first");
    expect(textOf(state.messages[1])).toBe("second!");
  });
});
