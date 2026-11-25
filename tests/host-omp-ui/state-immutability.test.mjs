import { describe, test, expect } from "bun:test";

// A reducer must produce a new state without mutating the one it was given.
// The streaming fast path broke that: it wrote into `state.liveSession.messages`
// itself, so the previous state — which AppShell, selectors, and any snapshot
// held by React still point at — changed under its readers. This is not a
// performance trade: it is observable, and with concurrent rendering it is
// exactly the tearing that immutable state exists to prevent.

const STORE = "../../host-omp-ui/web/src/protocol/store.ts";

function seeded() {
  return {
    type: "snapshot",
    session: { id: "s1", title: "Session 1", cwd: "/tmp/work" },
    messages: [
      { id: "m1", role: "user", blocks: [{ type: "text", text: "first" }] },
      { id: "m2", role: "assistant", blocks: [{ type: "text", text: "a" }], streaming: true },
      { id: "m3", role: "assistant", blocks: [{ type: "text", text: "tail" }] },
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

function delta(text) {
  return {
    type: "transcript.delta",
    seq: 2,
    kind: "text_delta",
    messageId: "m2",
    blockIndex: 0,
    delta: text,
  };
}

describe("a streaming frame does not rewrite the state it was given", () => {
  test("the previous state's messages keep their text and their array", async () => {
    const { reduceWebState, createInitialWebState } = await import(STORE);
    const initial = reduceWebState(createInitialWebState(), seeded());

    const beforeText = initial.liveSession.messages[1].blocks[0].text;
    const beforeArray = initial.liveSession.messages;
    const beforeIds = beforeArray.map((message) => message.id);
    expect(beforeText).toBe("a");

    const next = reduceWebState(initial, delta("b"));

    // The state that was passed in must be untouched: its array, its message
    // objects, and the text a stale reader would see.
    expect(initial.liveSession.messages).toBe(beforeArray);
    expect(initial.liveSession.messages.map((message) => message.id)).toEqual(beforeIds);
    expect(initial.liveSession.messages[1].blocks[0].text).toBe(beforeText);
    expect(initial.messages[1].blocks[0].text).toBe(beforeText);

    // The new state does carry the text.
    expect(next.liveSession.messages[1].blocks[0].text).toBe("ab");
    expect(next.messages[1].blocks[0].text).toBe("ab");
  });

  test("replaying the same frame twice from one state is deterministic", async () => {
    const { reduceWebState, createInitialWebState } = await import(STORE);
    const initial = reduceWebState(createInitialWebState(), seeded());

    const first = reduceWebState(initial, delta("b"));
    const second = reduceWebState(initial, delta("b"));

    // With a shared, mutated array the second run started from "ab" and built
    // "abb" — the same input produced a different state.
    expect(first.liveSession.messages[1].blocks[0].text).toBe("ab");
    expect(second.liveSession.messages[1].blocks[0].text).toBe("ab");
  });

  test("every state exposes a numeric streamRev, including the initial one", async () => {
    const { createInitialWebState } = await import(STORE);
    const initial = createInitialWebState();
    expect(typeof initial.streamRev).toBe("number");
    expect(initial.streamRev).toBe(0);
  });
});
