import { describe, expect, test } from "bun:test";
import {
  groupTranscriptForDisplay,
  reconstructTranscriptFromEntries,
} from "../../host-omp-ui/src/station/domain/transcript-model.mjs";
import { buildSteps, buildTurnGroups } from "../../host-omp-ui/web/src/lib/build-steps.ts";

const text = (value) => [{ type: "text", text: value }];
const thinking = (value) => [{ type: "thinking", text: value }];

function message(id, role, blocks, attribution) {
  const base = { id, role, blocks, streaming: false };
  if (attribution !== undefined) base.attribution = attribution;
  return base;
}

function user(id, value, attribution) {
  return { ...message(id, "user", text(value), attribution), text: value };
}

function assistant(id, blocks) {
  return { ...message(id, "assistant", blocks), text: "" };
}

function kinds(groups) {
  return groups.map((group) => group.kind);
}

function stepKinds(group) {
  return (group.steps ?? []).map((step) => step.kind);
}

describe("real user attribution", () => {
  test("session entries keep attribution on the ui message", () => {
    const messages = reconstructTranscriptFromEntries([
      {
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: text("typed by a person"),
          attribution: "user",
        },
      },
      {
        type: "message",
        id: "u2",
        message: {
          role: "user",
          content: text("injected by an agent"),
          attribution: "agent",
        },
      },
    ]);

    expect(messages[0].attribution).toBe("user");
    expect(messages[1].attribution).toBe("agent");
  });

  test("attribution agent is an input step, never a top-level user", () => {
    const groups = groupTranscriptForDisplay([
      user("u1", "task", "user"),
      assistant("a1", thinking("plan")),
      user("u2", "injected", "agent"),
      assistant("a2", text("final")),
    ]);

    expect(kinds(groups)).toEqual(["user_message", "step_group", "assistant_message"]);
    expect(stepKinds(groups[1])).toEqual(["thinking", "input"]);
    expect(groups[1].steps[1].text).toBe("injected");
    expect(groups[2].message.id).toBe("a2");
  });

  test("synthetic user text is an input step even when attribution says user", () => {
    const groups = groupTranscriptForDisplay([
      { ...user("u1", "injected by a child", "user"), synthetic: true },
      assistant("a1", text("final")),
    ]);

    expect(kinds(groups)).toEqual(["step_group", "assistant_message"]);
    expect(stepKinds(groups[0])).toEqual(["input"]);
    expect(groups[0].steps[0].text).toBe("injected by a child");
  });

  test("missing attribution is not a real user boundary", () => {
    const groups = groupTranscriptForDisplay([
      user("u1", "legacy typed message"),
      assistant("a1", text("final")),
    ]);

    expect(kinds(groups)).toEqual(["step_group", "assistant_message"]);
    expect(groups[0].steps.some((step) => step.kind === "input" && step.text === "legacy typed message")).toBe(true);
    expect(groups[1].message.id).toBe("a1");
  });

  test("assistant text before the next real user is the previous answer body", () => {
    const groups = groupTranscriptForDisplay([
      user("u1", "first", "user"),
      assistant("a1", text("intermediate")),
      user("u2", "second", "user"),
      assistant("a2", text("final")),
    ]);

    expect(kinds(groups)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "assistant_message",
    ]);
    expect(groups[1].message.id).toBe("a1");
    expect(groups[1].message.blocks[0].text).toBe("intermediate");
    expect(groups[3].message.id).toBe("a2");
  });
});

describe("web turn groups use the same boundary", () => {
  test("fake user becomes an input step and only the final assistant is body", () => {
    const groups = buildTurnGroups([
      user("u1", "task", "user"),
      assistant("a1", thinking("plan")),
      user("u2", "injected", "agent"),
      assistant("a2", text("final")),
    ]);

    expect(kinds(groups)).toEqual(["user", "processing"]);
    expect(stepKinds(groups[1])).toContain("input");
    expect(groups[1].steps.find((step) => step.kind === "input")?.text).toBe("injected");
    expect(groups[1].body).toBe("final");
  });

  test("real user splits turns; the previous assistant text is its body", () => {
    const groups = buildTurnGroups([
      user("u1", "first", "user"),
      assistant("a1", text("intermediate")),
      user("u2", "second", "user"),
      assistant("a2", text("final")),
    ]);

    expect(kinds(groups)).toEqual(["user", "processing", "user", "processing"]);
    expect(groups[1].body).toBe("intermediate");
    expect(groups[1].steps).toEqual([]);
    expect(groups[3].body).toBe("final");
  });

  test("missing attribution in the web grouping is also a fake user", () => {
    const groups = buildTurnGroups([
      user("u1", "legacy typed message"),
      assistant("a1", text("final")),
    ]);

    expect(kinds(groups)).toEqual(["processing"]);
    expect(stepKinds(groups[0])).toContain("input");
    expect(groups[0].body).toBe("final");
  });

  test("buildSteps forces a fake user message into steps with no body", () => {
    const built = buildSteps(user("u1", "injected", "agent"));

    expect(built.body).toBe("");
    expect(built.steps.map((step) => step.kind)).toEqual(["input"]);
    expect(built.steps[0].text).toBe("injected");
  });
});

describe("history cursor", () => {
  test("prefers the server oldest id over the first rendered message", async () => {
    const { resolveHistoryCursor } = await import(
      "../../host-omp-ui/web/src/lib/build-steps.ts"
    );
    expect(
      resolveHistoryCursor("server-oldest", [{ id: "rendered-first" }]),
    ).toBe("server-oldest");
  });

  test("falls back to the first rendered message when history has no cursor", async () => {
    const { resolveHistoryCursor } = await import(
      "../../host-omp-ui/web/src/lib/build-steps.ts"
    );
    expect(resolveHistoryCursor(null, [{ id: "rendered-first" }])).toBe(
      "rendered-first",
    );
    expect(resolveHistoryCursor(undefined, [])).toBeNull();
  });
});
