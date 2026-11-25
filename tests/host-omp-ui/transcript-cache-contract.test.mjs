import { describe, test, expect } from "bun:test";

// The transcript model keeps two caches: an id→index map on the message array
// and a shaped-copy cache in snapshot-fit. Both replaced a scan, so both must
// still answer exactly what the scan answered, including the ugly cases.

const MODEL = "../../host-omp-ui/src/station/domain/transcript-model.mjs";
const FIT = "../../host-omp-ui/src/station/domain/snapshot-fit.mjs";

const empty = () => ({ messages: [], streaming: null, toolExecutions: {} });

const end = (id, text) => ({
  type: "message_end",
  message: { id, role: "assistant", content: text },
});

describe("a tool result without a call id", () => {
  test("attaches to the first step that also has no id, instead of falling out of the group", async () => {
    const { groupTranscriptForDisplay } = await import(MODEL);
    const groups = groupTranscriptForDisplay([
      {
        id: "m1",
        role: "user",
        text: "go",
        blocks: [{ type: "text", text: "go" }],
      },
      {
        id: "m2",
        role: "assistant",
        blocks: [{ type: "toolCall", name: "bash", args: { command: "ls" } }],
      },
      { id: "m3", role: "toolResult", toolCallId: undefined, text: "output" },
    ]);
    const group = groups.find((entry) => entry.kind === "step_group");
    const tools = group.steps.filter((step) => step.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].toolResult?.text).toBe("output");
    expect(group.items).toBeUndefined();
  });

  test("still falls out of the group when no step has that id", async () => {
    const { groupTranscriptForDisplay } = await import(MODEL);
    const groups = groupTranscriptForDisplay([
      { id: "m1", role: "user", text: "go", blocks: [{ type: "text", text: "go" }] },
      {
        id: "m2",
        role: "assistant",
        blocks: [{ type: "toolCall", id: "call-1", name: "bash", args: {} }],
      },
      { id: "m3", role: "toolResult", toolCallId: "call-9", text: "orphan" },
    ]);
    const group = groups.find((entry) => entry.kind === "step_group");
    expect(group.items?.map((item) => item.id)).toEqual(["m3"]);
  });
});

describe("the message index answers like the scan it replaced", () => {
  test("an update lands on the first message with a repeated id", async () => {
    const { applyAgentEvent } = await import(MODEL);
    let state = empty();
    state = applyAgentEvent(state, end("dup", "first"));
    state = applyAgentEvent(state, end("other", "middle"));
    state = applyAgentEvent(state, end("dup", "again"));
    expect(state.messages.map((message) => message.id)).toEqual(["dup", "other"]);
    expect(state.messages[0].text).toBe("again");
    expect(state.messages[1].text).toBe("middle");
  });

  test("an appended message without an id does not shift later lookups", async () => {
    const { applyAgentEvent } = await import(MODEL);
    let state = empty();
    state = applyAgentEvent(state, end("a", "alpha"));
    state = applyAgentEvent(state, { type: "message_end", message: { role: "assistant", content: "no id" } });
    state = applyAgentEvent(state, end("b", "beta"));
    state = applyAgentEvent(state, end("a", "alpha2"));
    expect(state.messages).toHaveLength(3);
    expect(state.messages[0].text).toBe("alpha2");
    expect(state.messages[2].text).toBe("beta");
    expect(JSON.stringify(state.messages)).not.toContain("herd.messageIndex");
  });

  test("a replaced array starts a fresh index", async () => {
    const { applyAgentEvent } = await import(MODEL);
    let state = empty();
    state = applyAgentEvent(state, end("a", "alpha"));
    // A session switch hands in a different array that reuses the id.
    const switched = { messages: [{ id: "a", role: "assistant", text: "from disk" }], streaming: null };
    state = applyAgentEvent(switched, end("a", "patched"));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].text).toBe("patched");
  });
});

describe("the shaped-copy cache", () => {
  test("returns the same shape as an uncapped input and reuses it per object", async () => {
    const { capMessage, capTool } = await import(FIT);
    const message = { id: "m1", role: "assistant", blocks: [{ type: "text", text: "x".repeat(200000) }] };
    const first = capMessage(message);
    expect(capMessage(message)).toBe(first);
    expect(first.blocks[0].text.length).toBe(128 * 1024 + "\n… [truncated]".length);
    expect(first.blocks[0].truncated).toBe(true);
    expect(first.truncated).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("herd.messageIndex");

    const tool = { toolCallId: "t1", result: "y".repeat(300000) };
    expect(capTool(tool)).toBe(capTool(tool));
    expect(capTool(tool).result.length).toBe(128 * 1024 + "\n… [truncated]".length);
  });

  test("a distinct object with the same content is shaped independently", async () => {
    const { capMessage } = await import(FIT);
    const shape = () => ({ id: "m1", role: "assistant", blocks: [{ type: "text", text: "small" }] });
    const left = capMessage(shape());
    const right = capMessage(shape());
    expect(left).not.toBe(right);
    expect(left).toEqual(right);
  });
});
