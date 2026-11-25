import { describe, test, expect } from "bun:test";

import {
  buildTurnGroups,
  buildTurnGroupsResumable,
  sealedPrefixHolds,
} from "../../host-omp-ui/web/src/lib/build-steps.ts";

// A settled prefix may only be reused when the messages it was built from are
// still the very same objects. The previous test for that compared the two
// lists from the tail, which cannot answer the question: a list rewritten at
// both ends reports only the later change, and a list that gained a message at
// the front reports every position as matching while all of them shifted.
//
// These cases are driven through the real reducer, so the arrays are the ones
// the application actually groups.

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
  // The seeded snapshot collapses the streaming flags; restore the trailing
  // one so the open run matches a session that is producing text.
  state = {
    ...state,
    messages: state.messages.map((message) => ({
      ...message,
      streaming: message.id === "a2",
    })),
    liveSession: {
      ...state.liveSession,
      messages: state.liveSession.messages.map((message) => ({
        ...message,
        streaming: message.id === "a2",
      })),
    },
  };
  return { reduceWebState, state };
}

/** What the user sees: group order, kinds, and the text each group shows. */
function rendered(groups) {
  return groups.map((group) => {
    if (group.kind === "processing") {
      return {
        kind: group.kind,
        id: group.id,
        body: group.body,
        steps: group.steps.map((step) => (step.kind === "text" ? step.text : `tool:${step.tool?.name}`)),
      };
    }
    return { kind: group.kind, id: group.id, text: group.message.blocks?.[0]?.text ?? null };
  });
}

function delta(store, state, text, seq = 2) {
  return store(
    state,
    {
      type: "transcript.delta",
      seq,
      kind: "text_delta",
      messageId: "a2",
      blockIndex: 0,
      delta: text,
    },
  );
}

describe("sealedPrefixHolds", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c = { id: "c" };

  test("the same objects in the prefix hold", () => {
    expect(sealedPrefixHolds([a, b, c], [a, b, c], 3)).toBe(true);
    expect(sealedPrefixHolds([a, b, c], [a, b, c, { id: "d" }], 3)).toBe(true);
  });

  test("a change at the end does not disturb the prefix before it", () => {
    expect(sealedPrefixHolds([a, b, c], [a, b, { id: "c2" }], 2)).toBe(true);
    expect(sealedPrefixHolds([a, b, c], [a, b, { id: "c2" }], 3)).toBe(false);
  });

  test("a change at the front is seen even when both ends moved", () => {
    // The tail comparison returned only the later change; the prefix includes
    // the earlier one.
    expect(sealedPrefixHolds([a, b, c], [{ id: "a2" }, b, { id: "c2" }], 1)).toBe(false);
  });

  test("an inserted front message shifts everything and settles nothing", () => {
    expect(sealedPrefixHolds([a, b], [{ id: "x" }, a, b], 2)).toBe(false);
    expect(sealedPrefixHolds([a, b], [{ id: "x" }, a, b], 0)).toBe(true);
  });

  test("a shorter list cannot hold the prefix", () => {
    expect(sealedPrefixHolds([a, b, c], [a, b], 3)).toBe(false);
    expect(sealedPrefixHolds([a, b], [a], 2)).toBe(false);
  });
});

describe("grouping through the real reducer", () => {
  test("a text delta reuses the settled prefix and matches a full regroup", async () => {
    const { reduceWebState, state } = await start();
    const before = state.liveSession.messages;
    const first = buildTurnGroupsResumable(before, null);
    expect(first.cache.sealedCount).toBe(3);

    const nextState = delta(reduceWebState, state, "!");
    const after = nextState.liveSession.messages;
    expect(sealedPrefixHolds(before, after, first.cache.sealedCount)).toBe(true);

    const resumed = buildTurnGroupsResumable(after, first.cache);
    const full = buildTurnGroups(after);

    // The user-visible result is identical to regrouping everything.
    expect(rendered(resumed.groups)).toEqual(rendered(full));
    // And the prefix is the same objects, which is the cost that was removed.
    for (let index = 0; index < first.cache.sealed.length; index += 1) {
      expect(resumed.groups[index]).toBe(first.cache.sealed[index]);
    }
    // The settled text did not leak the new delta into an older turn.
    expect(resumed.groups[1].body).toBe("one");
  });

  test("a change at the front plus the tail refuses reuse and stays correct", async () => {
    const { reduceWebState, state } = await start();
    const before = state.liveSession.messages;
    const first = buildTurnGroupsResumable(before, null);

    const streamed = delta(reduceWebState, state, "!").liveSession.messages;
    // Both ends now differ: the first user message was rewritten as well.
    const rewritten = [
      { ...streamed[0], blocks: [{ type: "text", text: "first question, edited" }] },
      ...streamed.slice(1),
    ];

    expect(sealedPrefixHolds(before, rewritten, first.cache.sealedCount)).toBe(false);

    // The caller falls back; the groups must describe the edited message.
    const regrouped = buildTurnGroups(rewritten);
    expect(rendered(regrouped)).toEqual(rendered(buildTurnGroups(rewritten)));
    expect(regrouped[0].message.blocks[0].text).toBe("first question, edited");
    // Resuming anyway would have kept the old text on screen.
    const stale = buildTurnGroupsResumable(rewritten, first.cache);
    expect(rendered(stale.groups)).not.toEqual(rendered(regrouped));
  });

  test("an earlier page of history prepended to the list settles nothing", async () => {
    const { state } = await start();
    const before = state.liveSession.messages;
    const first = buildTurnGroupsResumable(before, null);

    const older = [
      {
        id: "u0",
        role: "user",
        attribution: "user",
        blocks: [{ type: "text", text: "an earlier question" }],
      },
      { id: "a0", role: "assistant", blocks: [{ type: "text", text: "an earlier answer" }] },
    ];
    const withHistory = [...older, ...before];

    expect(sealedPrefixHolds(before, withHistory, first.cache.sealedCount)).toBe(false);

    const regrouped = buildTurnGroups(withHistory);
    expect(rendered(regrouped)[0]).toEqual({
      kind: "user",
      id: "u0",
      text: "an earlier question",
    });
    // The reused prefix would have started mid-history and dropped the page.
    expect(regrouped.length).toBeGreaterThan(first.groups.length);
  });

  test("a truncated list is never resumed against a longer prefix", () => {
    const cache = buildTurnGroupsResumable(conversation, null).cache;
    const truncated = conversation.slice(0, 2);
    // The defensive guard inside the grouping refuses an oversized prefix.
    const result = buildTurnGroupsResumable(truncated, cache);
    expect(rendered(result.groups)).toEqual(rendered(buildTurnGroups(truncated)));
    expect(result.cache.sealedCount).toBeLessThanOrEqual(truncated.length);
  });
});

describe("the open run stays open", () => {
  test("a second frame into the same turn updates the body, not the prefix", async () => {
    const { reduceWebState, state } = await start();
    const first = buildTurnGroupsResumable(state.liveSession.messages, null);

    const second = delta(reduceWebState, delta(reduceWebState, state, "a", 2), "b", 3);
    const third = delta(reduceWebState, second, "c", 4);
    const resumed = buildTurnGroupsResumable(third.liveSession.messages, first.cache);

    expect(rendered(resumed.groups)).toEqual(
      rendered(buildTurnGroups(third.liveSession.messages)),
    );
    const last = resumed.groups.at(-1);
    expect(last.kind).toBe("processing");
    expect(last.body).toBe("twoabc");
  });

  test("an empty history groups to nothing", () => {
    const result = buildTurnGroupsResumable([], null);
    // The sequence is a persistent vector; compare its contents, not the
    // container shape. "Empty" is what the assertion means.
    expect([...result.groups]).toEqual([]);
    expect(result.cache.sealedCount).toBe(0);
  });
});

describe("the settled prefix is not re-sliced", () => {
  test("a frame that seals nothing reuses the previous prefix by reference", () => {
    const history = [
      { id: "u1", role: "user", attribution: "user", blocks: [{ type: "text", text: "first" }] },
      { id: "a1", role: "assistant", blocks: [{ type: "text", text: "one" }] },
      { id: "u2", role: "user", attribution: "user", blocks: [{ type: "text", text: "second" }] },
      { id: "a2", role: "assistant", blocks: [{ type: "text", text: "two" }], streaming: true },
    ];
    const first = buildTurnGroupsResumable(history, null);
    expect(first.cache.sealed.length).toBe(3);

    // A streaming frame rewrites the tail only: nothing new is sealed, so the
    // prefix list itself must be carried over rather than sliced again. That
    // slice was one copy of the settled history per frame.
    const streamed = [
      ...history.slice(0, 3),
      { ...history[3], blocks: [{ type: "text", text: "two!" }] },
    ];
    const resumed = buildTurnGroupsResumable(streamed, first.cache);
    expect(resumed.cache.sealed).toBe(first.cache.sealed);

    // Sealing a new turn rebuilds it, and still names the right prefix.
    const extended = [
      ...history,
      { id: "u3", role: "user", attribution: "user", blocks: [{ type: "text", text: "third" }] },
    ];
    const sealedMore = buildTurnGroupsResumable(extended, first.cache);
    expect(sealedMore.cache.sealed).not.toBe(first.cache.sealed);
    expect(sealedMore.cache.sealedCount).toBe(5);
    expect(sealedMore.cache.sealed.length).toBe(sealedMore.cache.sealedCount);
  });
});
