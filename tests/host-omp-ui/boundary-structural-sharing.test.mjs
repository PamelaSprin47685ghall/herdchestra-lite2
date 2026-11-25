import { describe, expect, test } from "bun:test";
import {
  createInitialWebState,
  reduceWebState,
  renderIndexes,
} from "../../host-omp-ui/web/src/protocol/store.ts";

// A boundary event — a message starting or ending, a tool attaching, the agent
// turn closing — used to copy the history into an array, mutate it, and rebuild
// the persistent vector. Three passes over the session per event is what made a
// long conversation stutter on every message boundary. The contract these tests
// pin: a boundary frame still produces the same messages, but the history keeps
// its structure (untouched messages keep their identity), the exact first
// changed index is reported, and the previous state is untouched.

function snapshot(messages, streaming = false) {
  return { type: "snapshot", session: { id: "s1" }, messages, streaming };
}

function history(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    blocks: [{ type: "text", text: `body ${index}` }],
  }));
}

function seeded(messages, streaming = false) {
  return reduceWebState(createInitialWebState(), snapshot(messages, streaming));
}

let seq = 0;

function frame(kind, rest) {
  seq += 1;
  return { type: "transcript.delta", seq, kind, ...rest };
}

describe("a message boundary keeps the history's structure", () => {
  test("message_start replaces only the appended message", () => {
    const before = seeded(history(600));
    const base = before.liveSession.messages;
    const first = base[0];
    const last = base[599];

    const next = reduceWebState(
      before,
      frame("message_start", {
        message: {
          id: "m600",
          role: "assistant",
          blocks: [{ type: "text", text: "new" }],
        },
      }),
    );
    const after = next.liveSession.messages;

    expect(after).toHaveLength(601);
    expect(after[0]).toBe(first);
    expect(after[599]).toBe(last);
    // The exact first changed index, not the 0 that forces a full regroup.
    expect(next.streamDirtyFrom).toBe(600);
    expect(after[600].blocks[0].text).toBe("new");
    // The state that was passed in is untouched.
    expect(base).toHaveLength(600);
    expect(base[599].blocks[0].text).toBe("body 599");
  });

  test("message_end touches its one message and reports that index", () => {
    const messages = history(600);
    messages.push({
      id: "m600",
      role: "assistant",
      streaming: true,
      blocks: [{ type: "text", text: "streaming" }],
    });
    const before = seeded(messages, true);
    const base = before.liveSession.messages;
    const head = base[0];

    const next = reduceWebState(
      before,
      frame("message_end", {
        messageId: "m600",
        message: {
          id: "m600",
          role: "assistant",
          blocks: [{ type: "text", text: "final" }],
        },
      }),
    );
    const after = next.liveSession.messages;

    expect(after[0]).toBe(head);
    expect(after[600].blocks[0].text).toBe("final");
    expect(after[600].streaming).toBe(false);
    expect(next.streamDirtyFrom).toBe(600);
    // Immutability: the previous version still shows the streaming message.
    expect(base[600].streaming).toBe(true);
    expect(base[600].blocks[0].text).toBe("streaming");
  });
});

describe("agent_end and tool frames stop paying for the whole session", () => {
  test("agent_end merges by id, appends the rest, and clears streaming", () => {
    const messages = history(600);
    messages[0] = { ...messages[0], streaming: true };
    const before = seeded(messages, true);
    const base = before.liveSession.messages;
    const second = base[1];

    const next = reduceWebState(
      before,
      frame("agent_end", {
        messages: [
          { id: "m0", role: "user", blocks: [{ type: "text", text: "rewritten" }] },
          { id: "m600", role: "assistant", blocks: [{ type: "text", text: "added" }] },
        ],
      }),
    );
    const after = next.liveSession.messages;

    expect(after).toHaveLength(601);
    expect(after[1]).toBe(second);
    expect(after[0].blocks[0].text).toBe("rewritten");
    expect(after[0].streaming).toBe(false);
    expect(after[600].blocks[0].text).toBe("added");
    // The first message was rewritten, so the settled prefix is empty.
    expect(next.streamDirtyFrom).toBe(0);
  });

  test("tool_start and tool_end touch one message and keep the tool index exact", () => {
    const before = seeded(history(600));
    const base = before.liveSession.messages;
    const head = base[0];

    const started = reduceWebState(
      before,
      frame("tool_start", { toolCallId: "t1", toolName: "read" }),
    );
    const attached = started.liveSession.messages;

    expect(attached[0]).toBe(head);
    expect(started.streamDirtyFrom).toBe(599);
    expect(
      attached[599].blocks.some((block) => block.toolCallId === "t1"),
    ).toBe(true);
    // The derived index reflects the frame without rescanning the history.
    expect(renderIndexes(attached).attachedToolIds.has("t1")).toBe(true);
    expect(renderIndexes(base).attachedToolIds.has("t1")).toBe(false);

    const ended = reduceWebState(
      started,
      frame("tool_end", { toolCallId: "t1", toolName: "read", result: "ok" }),
    );
    const finished = ended.liveSession.messages;

    expect(finished[0]).toBe(head);
    expect(ended.streamDirtyFrom).toBe(599);
    expect(
      finished[599].blocks.find((block) => block.toolCallId === "t1").result,
    ).toBe("ok");
    expect(
      finished[599].blocks.find((block) => block.toolCallId === "t1").status,
    ).toBe("completed");
    // The previous version keeps its own status.
    expect(
      attached[599].blocks.find((block) => block.toolCallId === "t1").status,
    ).toBe("running");
  });
});
