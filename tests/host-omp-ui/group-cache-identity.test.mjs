import { describe, test, expect } from "bun:test";

// Whether a cached grouping still describes the current conversation is a
// question about *identity*, and a version counter cannot answer it.
//
// The counter belongs to one state tree. A session switch, a reload, or any
// rebuild that resets it can land on the successor of a value the cache holds,
// and the two values then name two different conversations. The sequence's own
// lineage cannot do that: `diffFrom` compares versions, and a sequence that is
// not an ancestor answers 0, which falls back to a full regroup.
//
// These cases drive the real reducers and the real cache predicate.

const STORE = "../../host-omp-ui/web/src/protocol/store.ts";
const STEPS = "../../host-omp-ui/web/src/lib/build-steps.ts";
const LOG = "../../host-omp-ui/web/src/protocol/message-log.ts";

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

const conversationA = [
  {
    id: "a-u1",
    role: "user",
    attribution: "user",
    blocks: [{ type: "text", text: "A first question" }],
  },
  { id: "a-a1", role: "assistant", blocks: [{ type: "text", text: "A one" }] },
  {
    id: "a-u2",
    role: "user",
    attribution: "user",
    blocks: [{ type: "text", text: "A second question" }],
  },
  {
    id: "a-a2",
    role: "assistant",
    blocks: [{ type: "text", text: "A two" }],
    streaming: true,
  },
];

// A different conversation that shares no ids with the first.
const conversationB = [
  {
    id: "b-u1",
    role: "user",
    attribution: "user",
    blocks: [{ type: "text", text: "B first question" }],
  },
  { id: "b-a1", role: "assistant", blocks: [{ type: "text", text: "B one" }] },
  {
    id: "b-u2",
    role: "user",
    attribution: "user",
    blocks: [{ type: "text", text: "B second question" }],
  },
  {
    id: "b-a2",
    role: "assistant",
    blocks: [{ type: "text", text: "B two" }],
    streaming: true,
  },
];

async function load() {
  const store = await import(STORE);
  const steps = await import(STEPS);
  const log = await import(LOG);
  return { ...store, ...steps, MessageLog: log.MessageLog };
}

/** Seed a session. The list keeps its lineage: no plain-array round trip. */
function seed(state, messages, reduce) {
  return reduce(state, frame(messages));
}

function delta(reduce, state, { text, messageId, seq = 2 }) {
  return reduce(state, {
    type: "transcript.delta",
    seq,
    kind: "text_delta",
    messageId,
    blockIndex: 0,
    delta: text,
  });
}

describe("a stream frame inside one conversation", () => {
  test("reuses the settled prefix and matches a full regroup", async () => {
    const { reduceWebState, createInitialWebState, canReuseGroups, buildTurnGroups, buildTurnGroupsResumable } =
      await load();

    const first = seed(createInitialWebState(), conversationA, reduceWebState);
    const cached = buildTurnGroupsResumable(first.liveSession.messages, null);
    expect(cached.cache.sealedCount).toBe(3);

    const second = delta(reduceWebState, first, { text: "!", messageId: "a-a2" });
    const previous = { messages: first.liveSession.messages, cache: cached.cache };

    expect(canReuseGroups(previous, second.liveSession.messages)).toBe(true);

    const resumed = buildTurnGroupsResumable(second.liveSession.messages, cached.cache);
    const full = buildTurnGroups(second.liveSession.messages);
    expect(resumed.groups.map((group) => group.id)).toEqual(full.map((group) => group.id));
    // Reused by reference: that identity is the work the scan used to do.
    for (let index = 0; index < cached.cache.sealed.length; index += 1) {
      expect(resumed.groups[index]).toBe(cached.cache.sealed[index]);
    }
    expect(resumed.groups[1].body).toBe("A one");
  });

  test("a skipped frame is still reusable, because lineage proves the prefix", async () => {
    const { reduceWebState, createInitialWebState, canReuseGroups, buildTurnGroups, buildTurnGroupsResumable } =
      await load();

    const first = seed(createInitialWebState(), conversationA, reduceWebState);
    const cached = buildTurnGroupsResumable(first.liveSession.messages, null);

    const one = delta(reduceWebState, first, { text: "!", messageId: "a-a2", seq: 2 });
    const two = delta(reduceWebState, one, { text: "!", messageId: "a-a2", seq: 3 });

    // Two steps apart, but both moved the tail: the earliest change is still at
    // or past the settled boundary, so the prefix is provably the same objects.
    const previous = { messages: first.liveSession.messages, cache: cached.cache };
    expect(canReuseGroups(previous, two.liveSession.messages)).toBe(true);

    const resumed = buildTurnGroupsResumable(two.liveSession.messages, cached.cache);
    expect(resumed.groups.map((group) => group.id)).toEqual(
      buildTurnGroups(two.liveSession.messages).map((group) => group.id),
    );
    expect(resumed.groups.at(-1).body).toBe("A two!!");
  });
});

describe("a different conversation at a plausible counter value", () => {
  test("two sequences with no shared lineage are never reused", async () => {
    const { MessageLog, canReuseGroups, buildTurnGroupsResumable } = await load();

    // Two independent histories built from the same source. A counter could put
    // them one step apart; their versions say they are unrelated.
    const a = MessageLog.from(conversationA);
    const b = MessageLog.from(conversationA);
    const cached = buildTurnGroupsResumable(a, null);

    expect(canReuseGroups({ messages: a, cache: cached.cache }, b)).toBe(false);
  });

  test("a rebuilt sequence over the same ids is not an ancestor", async () => {
    const { MessageLog, canReuseGroups, buildTurnGroupsResumable } = await load();

    const first = MessageLog.from(conversationA);
    const cached = buildTurnGroupsResumable(first, null);
    const streamed = first.replace(3, {
      ...conversationA[3],
      blocks: [{ type: "text", text: "A two!" }],
    });

    // Rebuilt from a materialised copy: same ids, same contents, new lineage.
    const rebuilt = MessageLog.from(streamed.toArray());
    expect(canReuseGroups({ messages: first, cache: cached.cache }, rebuilt)).toBe(false);
  });

  test("a plain array carries no lineage and is never reused", async () => {
    const { canReuseGroups, buildTurnGroupsResumable } = await load();

    const cached = buildTurnGroupsResumable(conversationA, null);
    expect(cached.cache.sealedCount).toBeGreaterThan(0);
    // Session select rebuilds the state with a plain `messages: []`, and any
    // future path may hand an array. There is nothing to prove identity with.
    expect(canReuseGroups({ messages: conversationA, cache: cached.cache }, [])).toBe(false);
    expect(
      canReuseGroups(
        { messages: conversationA, cache: cached.cache },
        conversationA.slice(),
      ),
    ).toBe(false);
  });
});

describe("session switch through the real store", () => {
  test("a select resets to a plain list, and the old grouping is not reused", async () => {
    const { reduceWebState, createInitialWebState, canReuseGroups, buildTurnGroups, buildTurnGroupsResumable } =
      await load();

    const sessionA = seed(createInitialWebState(), conversationA, reduceWebState);
    const cached = buildTurnGroupsResumable(sessionA.liveSession.messages, null);
    expect(cached.cache.sealedCount).toBe(3);

    const selected = reduceWebState(sessionA, { type: "session.select", sessionId: "s2" });
    expect(selected.liveSession.messages.length).toBe(0);

    const sessionB = seed(selected, conversationB, reduceWebState);
    const previous = { messages: sessionA.liveSession.messages, cache: cached.cache };

    // Different conversation, no shared lineage, and the settled prefix of the
    // old one is not a prefix of this one at all.
    expect(canReuseGroups(previous, sessionB.liveSession.messages)).toBe(false);

    // The groups the user sees are session B's, built from scratch.
    const groups = buildTurnGroups(sessionB.liveSession.messages);
    expect(groups[1].body).toBe("B one");
    expect(groups.map((group) => group.id)).toContain("b-u1");
    expect(groups.map((group) => group.id)).not.toContain("a-u1");

    // Reusing the old prefix anyway is exactly the stale-turn failure: the old
    // text would still be on screen.
    const stale = buildTurnGroupsResumable(sessionB.liveSession.messages, cached.cache);
    expect(stale.groups[1].body).toBe("A one");
  });

  test("re-selecting the same session also refuses the old prefix", async () => {
    const { reduceWebState, createInitialWebState, canReuseGroups, buildTurnGroupsResumable } =
      await load();

    const first = seed(createInitialWebState(), conversationA, reduceWebState);
    const cached = buildTurnGroupsResumable(first.liveSession.messages, null);

    // Same id, fresh state: the React key does not change, so the component
    // keeps its ref and this predicate is the only guard.
    const reselected = reduceWebState(first, { type: "session.select", sessionId: "s1" });
    expect(canReuseGroups({ messages: first.liveSession.messages, cache: cached.cache }, reselected.liveSession.messages)).toBe(
      false,
    );

    const reseeded = seed(reselected, conversationA, reduceWebState);
    expect(
      canReuseGroups(
        { messages: first.liveSession.messages, cache: cached.cache },
        reseeded.liveSession.messages,
      ),
    ).toBe(false);
  });
});
