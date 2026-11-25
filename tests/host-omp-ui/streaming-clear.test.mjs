import { describe, test, expect } from "bun:test";

// The clearing pass must run whenever ANOTHER message claims to stream. The
// earlier fast-path test compared the target with the LAST streaming message,
// which says nothing about an earlier one still streaming, and the snapshot
// fixture collapsed the two flags into one, so the branch was never reached.

const STORE = "../../host-omp-ui/web/src/protocol/store.ts";

function seeded() {
  return {
    type: "snapshot",
    session: { id: "s1", title: "Session 1", cwd: "/tmp/work" },
    messages: [
      { id: "m1", role: "assistant", blocks: [{ type: "text", text: "a" }], streaming: true },
      { id: "m2", role: "assistant", blocks: [{ type: "text", text: "b" }], streaming: true },
    ],
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
  };
}

describe("a delta that moves the stream", () => {
  test("clears an earlier streaming message even when the target is the last one", async () => {
    const { reduceWebState, createInitialWebState } = await import(STORE);
    let state = reduceWebState(createInitialWebState(), seeded());

    // Force the precondition the snapshot normaliser removes: two messages
    // streaming, the target being the later one. Both mirrors of the array must
    // move together — the reducer reads `liveSession.messages`, so assigning
    // only `messages` would leave the test driving an array nobody reads.
    const bothStreaming = state.liveSession.messages.map((m) => ({
      ...m,
      streaming: true,
    }));
    state = {
      ...state,
      messages: bothStreaming,
      liveSession: { ...state.liveSession, messages: bothStreaming },
    };
    const order = state.liveSession.messages.map((m) => m.id);
    expect(order).toEqual(["m1", "m2"]);

    const next = reduceWebState(state, {
      type: "transcript.delta",
      seq: 2,
      kind: "text_delta",
      messageId: "m2",
      blockIndex: 0,
      delta: "!",
    });

    const byId = Object.fromEntries(next.messages.map((m) => [m.id, m]));
    expect(byId.m1.streaming).toBe(false);
    expect(byId.m2.streaming).toBe(true);
    expect(byId.m2.blocks[0].text).toBe("b!");
  });

  test("a steady-state delta leaves the single streaming message alone", async () => {
    const { reduceWebState, createInitialWebState } = await import(STORE);
    let state = reduceWebState(createInitialWebState(), seeded());
    state = {
      ...state,
      messages: state.messages.map((m) => ({ ...m, streaming: m.id === "m2" })),
    };

    const next = reduceWebState(state, {
      type: "transcript.delta",
      seq: 2,
      kind: "text_delta",
      messageId: "m2",
      blockIndex: 0,
      delta: "!",
    });

    const byId = Object.fromEntries(next.messages.map((m) => [m.id, m]));
    expect(byId.m1.streaming).toBe(false);
    expect(byId.m2.streaming).toBe(true);
  });

  test("two messages sharing an id still clear each other", async () => {
    const { reduceWebState, createInitialWebState } = await import(STORE);
    let state = reduceWebState(createInitialWebState(), seeded());
    // `normalizeMessages` does not deduplicate, so this shape can reach the
    // reducer. An id-keyed index would see a single streaming id, decide nobody
    // else is streaming, and leave the first message stuck on "generating".
    const shared = state.liveSession.messages.map((m) => ({
      ...m,
      id: "same",
      streaming: true,
    }));
    state = {
      ...state,
      messages: shared,
      liveSession: { ...state.liveSession, messages: shared },
    };

    const next = reduceWebState(state, {
      type: "transcript.delta",
      seq: 2,
      kind: "text_delta",
      messageId: "same",
      blockIndex: 0,
      delta: "!",
    });

    // The delta lands on the first occurrence, matching findIndex, and the
    // other message with that id must stop claiming to stream.
    expect(next.messages.filter((m) => m.streaming).length).toBe(1);
    expect(next.messages[0].streaming).toBe(true);
    expect(next.messages[1].streaming).toBe(false);
  });
});
