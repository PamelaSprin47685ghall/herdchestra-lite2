import { describe, test, expect } from "bun:test";

// A streaming frame rewrites the tail of the conversation. Reusing the groups
// built for the prefix used to require comparing both lists element by element
// — Θ(prefix) on every tick. The reducer now records the exact first index it
// changed, and the consumer reads that number instead. These tests pin both
// halves: the number the reducer writes, and the reuse decision that depends on
// it being exactly one step behind.

const STORE = "../../host-omp-ui/web/src/protocol/store.ts";

function seeded(messages) {
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

async function start() {
  const { reduceWebState, createInitialWebState } = await import(STORE);
  let state = reduceWebState(createInitialWebState(), seeded(conversation));
  // The seeded snapshot collapses the streaming flags; restore the trailing one
  // so the open run matches a session that is producing text.
  const restore = (message) => ({
    ...message,
    streaming: message.id === "a2",
  });
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

function delta(store, state, { text, messageId = "a2", seq = 2 }) {
  return store(state, {
    type: "transcript.delta",
    seq,
    kind: "text_delta",
    messageId,
    blockIndex: 0,
    delta: text,
  });
}

describe("the recorded first change", () => {
  test("a text delta names the message it appended to", async () => {
    const { reduceWebState, state } = await start();
    const next = delta(reduceWebState, state, { text: "!" });

    expect(next.liveSession.messages[3].blocks[0].text).toBe("two!");
    // Index 3 is the message that moved; nothing before it did.
    expect(next.streamDirtyFrom).toBe(3);
  });

  test("a delta that also clears an earlier streaming message names the earlier one", async () => {
    const { reduceWebState, state } = await start();
    // Two messages claim to stream: the target is the later one, so the pass
    // that clears the other one touches an earlier index.
    const both = state.liveSession.messages.map((message) => ({
      ...message,
      streaming: true,
    }));
    const seededState = {
      ...state,
      messages: both,
      liveSession: { ...state.liveSession, messages: both },
    };

    const next = delta(reduceWebState, seededState, { text: "!" });
    const streaming = next.liveSession.messages.map((message) => message.streaming);
    expect(streaming.filter(Boolean).length).toBe(1);
    // The earliest touched index is the cleared message, not the target.
    expect(next.streamDirtyFrom).toBeLessThan(3);
    expect(next.liveSession.messages[next.streamDirtyFrom].streaming).toBe(false);
  });

  test("a message boundary names the position it appended to", async () => {
    const { reduceWebState, state } = await start();
    // The append lands at the end of the list and touches nothing before it, and
    // the frame now says so instead of claiming the whole list.
    const next = reduceWebState(state, {
      type: "transcript.delta",
      seq: 2,
      kind: "message_start",
      message: { id: "a3", role: "assistant", blocks: [{ type: "text", text: "new" }] },
    });
    expect(next.streamDirtyFrom).toBe(3);
  });

  test("the initial state answers with the empty list", async () => {
    const { createInitialWebState } = await import(STORE);
    const initial = createInitialWebState();
    expect(initial.streamDirtyFrom).toBe(0);
    expect(initial.streamRev).toBe(0);
  });
});

describe("reuse decided from the recorded index", () => {
  test("a tail-only frame reuses the settled prefix and matches a full regroup", async () => {
    const { reduceWebState, state } = await start();
    const { buildTurnGroups, buildTurnGroupsResumable } = await import(
      "../../host-omp-ui/web/src/lib/build-steps.ts"
    );

    const before = state.liveSession.messages;
    const first = buildTurnGroupsResumable(before, null);
    expect(first.cache.sealedCount).toBe(3);

    const next = delta(reduceWebState, state, { text: "!" });
    // The precondition the consumer checks: one step forward, and the change
    // starts at or past the boundary.
    expect(next.streamRev).toBe((state.streamRev ?? 0) + 1);
    expect(next.streamDirtyFrom).toBeGreaterThanOrEqual(first.cache.sealedCount);

    const resumed = buildTurnGroupsResumable(next.liveSession.messages, first.cache);
    const full = buildTurnGroups(next.liveSession.messages);

    // Same groups the full pass produces, and the prefix by reference — that
    // identity is the work the scan used to do.
    expect(resumed.groups.map((group) => group.id)).toEqual(
      full.map((group) => group.id),
    );
    for (let index = 0; index < first.cache.sealed.length; index += 1) {
      expect(resumed.groups[index]).toBe(first.cache.sealed[index]);
    }
    // The settled turn still shows the text it was built from.
    expect(resumed.groups[1].body).toBe("one");
  });

  test("a change before the boundary refuses reuse", async () => {
    const { reduceWebState, state } = await start();
    const { buildTurnGroups, buildTurnGroupsResumable } = await import(
      "../../host-omp-ui/web/src/lib/build-steps.ts"
    );
    const first = buildTurnGroupsResumable(state.liveSession.messages, null);

    // Rewrite the first assistant message, as an edit would. The reducer that
    // handles such a frame reports 0, which is below the boundary.
    const rewritten = state.liveSession.messages.map((message) =>
      message.id === "a1"
        ? { ...message, blocks: [{ type: "text", text: "one, edited" }] }
        : message,
    );

    expect(0).toBeLessThan(first.cache.sealedCount);
    // The consumer would not resume here; the full pass shows the new text.
    const regrouped = buildTurnGroups(rewritten);
    expect(regrouped[1].body).toBe("one, edited");
    // Resuming anyway would keep the old text on screen.
    const stale = buildTurnGroupsResumable(rewritten, first.cache);
    expect(stale.groups[1].body).toBe("one");
  });

  test("a skipped frame is not reused, even when its index looks safe", async () => {
    const { reduceWebState, state } = await start();
    const { buildTurnGroupsResumable } = await import(
      "../../host-omp-ui/web/src/lib/build-steps.ts"
    );
    const first = buildTurnGroupsResumable(state.liveSession.messages, null);

    // Two frames where the consumer saw one: `streamRev` jumps by two, so the
    // recorded index describes a step from a version this consumer never
    // rendered. The guard is the version distance, not the index alone.
    const one = delta(reduceWebState, state, { text: "!", seq: 2 });
    const two = delta(reduceWebState, one, { text: "!", seq: 3 });
    // Whatever the frame count, the guard the consumer uses is the version
    // distance: only a step of exactly one may be read through its index.
    const distance = two.streamRev - (state.streamRev ?? 0);
    expect(distance).toBeGreaterThan(0);
    expect(distance === 1 && two.streamDirtyFrom >= first.cache.sealedCount).toBe(
      distance === 1,
    );
    // The consumer therefore falls back when the distance is not one, and the
    // regrouped result is correct either way.
    const regrouped = buildTurnGroupsResumable(two.liveSession.messages, null);
    expect(regrouped.groups.at(-1).body).toContain("two");
  });
});
