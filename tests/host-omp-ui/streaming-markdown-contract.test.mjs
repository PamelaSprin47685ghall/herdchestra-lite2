import { describe, expect, test } from "bun:test";
import {
  buildSteps,
  buildTurnGroups,
  shouldShowStreamingFooter,
} from "../../host-omp-ui/web/src/lib/build-steps.ts";

const user = (id, text) => ({
  id,
  role: "user",
  attribution: "user",
  blocks: [{ type: "text", text }],
});
const assistant = (id, blocks, streaming = false) => ({
  id,
  role: "assistant",
  blocks,
  streaming,
});
const thinking = (text) => ({ type: "thinking", text });
const text = (value) => ({ type: "text", text: value });
const tool = (id, name = "read") => ({
  type: "toolCall",
  id,
  toolCallId: id,
  name,
  args: {},
});

const processing = (groups) =>
  groups.find((group) => group.kind === "processing");

describe("streaming markdown lifecycle", () => {
  test("only the active step is streaming; completed steps stay finished", () => {
    const groups = buildTurnGroups([
      user("u1", "do it"),
      assistant("a1", [thinking("planned")]),
      assistant("a2", [thinking("still thinking")], true),
    ]);
    const group = processing(groups);
    expect(group.steps.map((step) => step.streaming)).toEqual([false, true]);
    expect(group.stepsFinished).toBe(false);
    expect(group.bodyFinished).toBe(true);
  });

  test("an unfinished body does not mark completed steps as streaming", () => {
    const groups = buildTurnGroups([
      user("u1", "write"),
      assistant("a1", [thinking("planned"), tool("t1")]),
      assistant("a2", [text("partial answer")], true),
    ]);
    const group = processing(groups);
    expect(group.steps.map((step) => step.streaming)).toEqual([false, false]);
    expect(group.stepsFinished).toBe(true);
    expect(group.bodyFinished).toBe(false);
    expect(group.body).toBe("partial answer");
  });

  test("a streaming thinking block with no body finishes only the body", () => {
    const built = buildSteps(
      assistant("a1", [thinking("in progress")], true),
    );
    expect(built.steps.map((step) => step.streaming)).toEqual([true]);
    expect(built.body).toBe("");
    expect(built.bodyFinished).toBe(true);
    expect(built.stepsFinished).toBe(false);
  });

  test("a finished message has all steps and body finished", () => {
    const built = buildSteps(
      assistant("a1", [thinking("done"), text("answer")], false),
    );
    expect(built.steps.map((step) => step.streaming)).toEqual([false]);
    expect(built.body).toBe("answer");
    expect(built.bodyFinished).toBe(true);
    expect(built.stepsFinished).toBe(true);
  });

  test("an empty streaming assistant keeps a stable group and a footer slot", () => {
    const groups = buildTurnGroups([
      user("u1", "wait"),
      assistant("a1", [], true),
    ]);
    const group = processing(groups);
    expect(group).toBeDefined();
    expect(group.id).toBe("a1");
    expect(group.steps).toEqual([]);
    expect(group.body).toBe("");
    expect(group.bodyFinished).toBe(false);
    expect(group.stepsFinished).toBe(true);
    expect(shouldShowStreamingFooter(group)).toBe(true);
  });

  test("the footer disappears as soon as the turn has visible content", () => {
    const withSteps = processing(
      buildTurnGroups([
        user("u1", "x"),
        assistant("a1", [thinking("working")], true),
      ]),
    );
    expect(shouldShowStreamingFooter(withSteps)).toBe(false);

    const withBody = processing(
      buildTurnGroups([
        user("u1", "x"),
        assistant("a1", [text("partial")], true),
      ]),
    );
    expect(shouldShowStreamingFooter(withBody)).toBe(false);

    const finished = processing(
      buildTurnGroups([
        user("u1", "x"),
        assistant("a1", [text("done")], false),
      ]),
    );
    expect(shouldShowStreamingFooter(finished)).toBe(false);
  });
});
