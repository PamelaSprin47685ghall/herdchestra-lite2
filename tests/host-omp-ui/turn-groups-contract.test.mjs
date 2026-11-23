import { describe, expect, test } from "bun:test";
import { buildTurnGroups } from "../../host-omp-ui/web/src/lib/build-steps.ts";

const user = (id, text) => ({
  id,
  role: "user",
  attribution: "user",
  blocks: [{ type: "text", text }],
});
const fakeUser = (id, text) => ({
  id,
  role: "user",
  attribution: "agent",
  blocks: [{ type: "text", text }],
});
const assistant = (id, blocks, streaming = false) => ({
  id,
  role: "assistant",
  blocks,
  streaming,
});
const tool = (id, name = "read") => ({
  type: "toolCall",
  id,
  toolCallId: id,
  name,
  args: {},
});

test("custom messages merge into turn steps and never become body", () => {
  const custom = {
    id: "c1",
    role: "custom",
    text: "guide text",
    customType: "prelude",
  };
  const groups = buildTurnGroups([
    user("u1", "hi"),
    assistant("a1", [{ type: "thinking", text: "plan" }]),
    custom,
    assistant("a2", [{ type: "text", text: "final" }]),
  ]);
  expect(groups.map((group) => group.kind)).toEqual(["user", "processing"]);
  const processing = groups[1];
  expect(processing.kind).toBe("processing");
  if (processing.kind !== "processing") return;
  const steps = processing.segments.flatMap((segment) => segment.steps);
  expect(steps.map((step) => step.kind)).toEqual(["thinking", "text"]);
  expect(steps[1].format).toBe("pre");
  expect(processing.body).toBe("final");
  expect(processing.totalSteps).toBe(2);
});

describe("buildTurnGroups", () => {
  test("one turn merges multiple assistant messages into one processing group", () => {
    const groups = buildTurnGroups([
      user("u1", "do the task"),
      assistant("a1", [{ type: "thinking", text: "plan" }]),
      assistant("a2", [{ type: "text", text: "inspect" }]),
      assistant("a3", [tool("t1")]),
      assistant("a4", [{ type: "text", text: "final answer" }]),
      user("u2", "next"),
    ]);

    expect(groups.map((group) => group.kind)).toEqual([
      "user",
      "processing",
      "user",
    ]);
    const processing = groups[1];
    expect(processing.id).toBe("a1");
    expect(processing.messages.map((message) => message.id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
    ]);
    expect(processing.steps.map((step) => step.kind)).toEqual([
      "thinking",
      "text",
      "tool",
    ]);
    expect(processing.steps[1].text).toBe("inspect");
    expect(processing.body).toBe("final answer");
  });

  test("intermediate assistant text is a step, only the last text is body", () => {
    const groups = buildTurnGroups([
      user("u1", "go"),
      assistant("a1", [{ type: "text", text: "first" }]),
      assistant("a2", [{ type: "text", text: "second" }]),
    ]);
    const processing = groups.find((group) => group.kind === "processing");
    expect(processing.steps).toHaveLength(1);
    expect(processing.steps[0]).toMatchObject({ kind: "text", text: "first" });
    expect(processing.body).toBe("second");
  });

  test("group ids are stable and start at the first message of the run", () => {
    const messages = [
      user("u1", "x"),
      assistant("a1", [{ type: "thinking", text: "t" }]),
      assistant("a2", [{ type: "text", text: "body" }]),
    ];
    const first = buildTurnGroups(messages);
    const second = buildTurnGroups(messages);
    expect(first.map((group) => group.id)).toEqual(["u1", "a1"]);
    expect(second.map((group) => group.id)).toEqual(first.map((group) => group.id));
  });

  test("a streaming message marks its processing group streaming", () => {
    const groups = buildTurnGroups([
      user("u1", "x"),
      assistant("a1", [{ type: "thinking", text: "t" }], true),
      assistant("a2", [{ type: "text", text: "body" }], true),
    ]);
    const processing = groups.find((group) => group.kind === "processing");
    expect(processing.streaming).toBe(true);
  });

  test("non-assistant roles outside a run keep their own groups", () => {
    const groups = buildTurnGroups([
      user("u1", "x"),
      assistant("a1", [{ type: "text", text: "answer" }]),
      { id: "b1", role: "bashExecution", command: "ls", output: "" },
      { id: "c1", role: "compactionSummary", summary: "s" },
    ]);
    expect(groups.map((group) => group.kind)).toEqual([
      "user",
      "processing",
      "terminal",
      "boundary",
    ]);
  });

  test("paired toolResult does not duplicate the tool step", () => {
    const groups = buildTurnGroups([
      user("u1", "run"),
      assistant("a1", [tool("t1")]),
      {
        id: "r1",
        role: "toolResult",
        toolCallId: "t1",
        blocks: [{ type: "text", text: "tool output" }],
      },
    ]);
    const processing = groups.find((group) => group.kind === "processing");
    expect(processing.body).toBe("");
    expect(processing.steps.map((step) => step.kind)).toEqual(["tool"]);
    expect(processing.totalSteps).toBe(1);
  });

  test("orphan toolResult stays a pre step and never becomes body", () => {
    const groups = buildTurnGroups([
      user("u1", "run"),
      assistant("a1", [tool("t1")]),
      {
        id: "r2",
        role: "toolResult",
        toolCallId: "missing",
        blocks: [{ type: "text", text: "orphan output" }],
      },
    ]);
    const processing = groups.find((group) => group.kind === "processing");
    expect(processing.body).toBe("");
    expect(processing.steps.map((step) => step.kind)).toEqual(["tool", "text"]);
    expect(processing.steps[1]).toMatchObject({
      kind: "text",
      format: "pre",
      text: "orphan output",
    });
  });

  test("adjacent thinking blocks stay one Markdown document", () => {
    const groups = buildTurnGroups([
      user("u1", "go"),
      assistant("a1", [
        { type: "thinking", text: "```js\nconst a = 1;" },
        { type: "thinking", text: "const b = 2;\n```" },
      ]),
      assistant("a2", [{ type: "text", text: "done" }]),
    ]);
    const processing = groups.find((group) => group.kind === "processing");
    expect(processing.steps).toHaveLength(1);
    expect(processing.steps[0].kind).toBe("thinking");
    expect(processing.steps[0].text).toBe(
      "```js\nconst a = 1;\nconst b = 2;\n```",
    );
  });

  test("developer messages are steps, never assistant body", () => {
    const groups = buildTurnGroups([
      user("u1", "go"),
      {
        id: "d1",
        role: "developer",
        blocks: [{ type: "text", text: "system guidance" }],
      },
      assistant("a1", [{ type: "text", text: "final answer" }]),
    ]);
    const processing = groups.find((group) => group.kind === "processing");
    expect(processing.steps).toHaveLength(1);
    expect(processing.steps[0]).toMatchObject({
      kind: "text",
      text: "system guidance",
    });
    expect(processing.body).toBe("final answer");

    const developerOnly = buildTurnGroups([
      user("u2", "next"),
      {
        id: "d2",
        role: "developer",
        blocks: [{ type: "text", text: "more guidance" }],
      },
    ]);
    const group = developerOnly.find((item) => item.kind === "processing");
    expect(group.body).toBe("");
    expect(group.steps[0]).toMatchObject({
      kind: "text",
      text: "more guidance",
    });
  });
});
