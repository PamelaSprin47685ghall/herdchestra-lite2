import { describe, test, expect } from "bun:test";

// `streamRev` only proves immediacy if *every* transition that replaces the
// message sequence advances it.
//
// The vulnerable sequence: the consumer caches a grouping at rev R. A snapshot
// replaces the whole list. Then a stream frame arrives. If the snapshot left
// `streamRev` alone, the frame lands at exactly R + 1 — indistinguishable from
// one step over the same list — and the consumer reuses a prefix built from
// messages the snapshot had already replaced. The stale turn stays on screen.
//
// These cases drive the real reducers, so the sequence is the one the
// application actually produces.

const STORE = "../../host-omp-ui/web/src/protocol/store.ts";

function snapshotWith(messages, overrides = {}) {
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

const original = [
  {
    id: "u1",
    role: "user",
    attribution: "user",
    blocks: [{ type: "text", text: "first question" }],
  },
  { id: "a1", role: "assistant", blocks: [{ type: "text", text: "one" }] },
  {
    id: "u2",
    role: "user",
    attribution: "user",
    blocks: [{ type: "text", text: "second question" }],
  },
  {
    id: "a2",
    role: "assistant",
    blocks: [{ type: "text", text: "two" }],
    streaming: true,
  },
];

// The same conversation with its first turn rewritten, as a resync would
// deliver it after the server compacted or edited earlier history.
const rewritten = [
  {
    id: "u1",
    role: "user",
    attribution: "user",
    blocks: [{ type: "text", text: "first question, rephrased" }],
  },
  { id: "a1", role: "assistant", blocks: [{ type: "text", text: "one, rephrased" }] },
  {
    id: "u2",
    role: "user",
    attribution: "user",
    blocks: [{ type: "text", text: "second question" }],
  },
  {
    id: "a2",
    role: "assistant",
    blocks: [{ type: "text", text: "two" }],
    streaming: true,
  },
];

async function start(messages = original) {
  const { reduceWebState, createInitialWebState } = await import(STORE);
  let state = reduceWebState(createInitialWebState(), snapshotWith(messages));
  const restore = (message) => ({ ...message, streaming: message.id === "a2" });
  state = {
    ...state,
    messages: state.messages.map(restore),
    liveSession: {
      ...state.liveSession,
      messages: state.liveSession.messages.map(restore),
    },
  };
  return { reduceWebState, state };
}

function delta(store, state, { text, seq = 2 }) {
  return store(state, {
    type: "transcript.delta",
    seq,
    kind: "text_delta",
    messageId: "a2",
    blockIndex: 0,
    delta: text,
  });
}

function resync(store, state, messages) {
  return store(state, snapshotWith(messages));
}

describe("a replacement between two stream frames", () => {
  test("a snapshot consumes a version, so the next frame is not one step from the cache", async () => {
    const { reduceWebState, state } = await start();
    const cachedRev = state.streamRev ?? 0;

    // The whole list is replaced by a resync. This must cost a version.
    const afterSnapshot = resync(reduceWebState, state, rewritten);
    expect(afterSnapshot.streamRev).toBeGreaterThan(cachedRev);

    const afterFrame = delta(reduceWebState, afterSnapshot, { text: "!" });

    // Distance from the cache must exceed one, which is what tells the consumer
    // its grouping is stale. Before the fix both replacements left the counter
    // alone and this frame arrived at exactly cachedRev + 1.
    expect(afterFrame.streamRev - cachedRev).toBeGreaterThan(1);
  });

  test("the grouping a consumer would build describes the replaced history", async () => {
    const { reduceWebState, state } = await start();
    const { buildTurnGroups, buildTurnGroupsResumable } = await import(
      "../../host-omp-ui/web/src/lib/build-steps.ts"
    );

    const cached = buildTurnGroupsResumable(state.liveSession.messages, null);
    expect(cached.groups[1].body).toBe("one");

    const afterSnapshot = resync(reduceWebState, state, rewritten);
    const afterFrame = delta(reduceWebState, afterSnapshot, { text: "!" });

    // The consumer's guard: only one step behind AND the change at or past the
    // boundary. The replacement broke both, so it regroups.
    const oneStepBehind = afterFrame.streamRev === (state.streamRev ?? 0) + 1;
    expect(oneStepBehind).toBe(false);

    const regrouped = buildTurnGroups(afterFrame.liveSession.messages);
    expect(regrouped[1].body).toBe("one, rephrased");
    // Reusing the cached prefix would still show the pre-resync text.
    const stale = buildTurnGroupsResumable(afterFrame.liveSession.messages, cached.cache);
    expect(stale.groups[1].body).toBe("one");
  });

  test("an untouched stream frame still advances by exactly one", async () => {
    const { reduceWebState, state } = await start();
    const before = state.streamRev ?? 0;
    const next = delta(reduceWebState, state, { text: "!" });

    // The ordinary path must keep proving immediacy: one frame, one version.
    expect(next.streamRev).toBe(before + 1);
    expect(next.streamDirtyFrom).toBe(3);
  });

  test("the rule lives in liveCommit, so every caller inherits it", async () => {
    const { state } = await start();
    const { liveCommit } = await import(
      "../../host-omp-ui/web/src/protocol/reducers/live.ts"
    );
    const before = state.streamRev ?? 0;

    // A caller that swaps the sequence but reports nothing — a prepend, a
    // resync, any future path — must still consume a version. Putting the rule
    // in each caller is what the bug was: one of them will forget.
    const prepended = [
      { id: "older", role: "assistant", blocks: [{ type: "text", text: "before" }] },
      ...state.liveSession.messages,
    ];
    const afterPrepend = liveCommit(state, { messages: prepended });
    expect(afterPrepend.streamRev).toBe(before + 1);
    expect(afterPrepend.streamDirtyFrom).toBe(0);

    // Handing back the same sequence is not a step: it must not consume one,
    // or a consumer would see gaps that never happened and stop reusing.
    const sameSequence = liveCommit(afterPrepend, {
      messages: afterPrepend.liveSession.messages,
    });
    expect(sameSequence.streamRev).toBe(before + 1);
  });
});
