// The Web UI is moving from per-message rendering to a step timeline:
// thinking, tool calls and intermediate text are all steps, and adjacent
// steps from consecutive assistant messages merge into one expandable group.
// The group count the user sees must include thinking, not just tool calls.
//
// This contract lives on the pure transcript-model module so the shape is
// decided once, not re-derived in React. toolResult must still be attached to
// the tool step it belongs to, and a final answer must stay body text rather
// than being swallowed into the step group.

import { expect, test } from "bun:test";

const MODULE = "../../host-omp-ui/src/station/domain/transcript-model.mjs";

async function load() {
	return import(MODULE);
}

test("thinking, tool calls and intermediate text become ordered steps; final text stays body", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{
			id: "a1",
			role: "assistant",
			blocks: [
				{ type: "thinking", text: "plan" },
				{ type: "toolCall", id: "tc1", name: "read", args: { path: "a" } },
				{ type: "text", text: "intermediate" },
				{ type: "toolCall", id: "tc2", name: "write", args: { path: "b" } },
				{ type: "text", text: "final answer" },
			],
		},
	]);

	expect(groups.map((group) => group.kind)).toEqual(["step_group", "assistant_message"]);

	const stepGroup = groups[0];
	expect(stepGroup.steps.map((step) => step.kind)).toEqual([
		"thinking",
		"tool",
		"text",
		"tool",
	]);
	expect(stepGroup.steps.map((step) => step.text ?? step.name)).toEqual([
		"plan",
		"read",
		"intermediate",
		"write",
	]);
	expect(groups[1].message.id).toBe("a1");
	expect(groups[1].message.blocks.at(-1).text).toBe("final answer");
});

test("thinking counts toward the visible step count", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{
			id: "a1",
			role: "assistant",
			blocks: [
				{ type: "thinking", text: "first thought" },
				{ type: "toolCall", id: "tc1", name: "read", args: {} },
			],
		},
	]);

	expect(groups[0].kind).toBe("step_group");
	expect(groups[0].steps).toHaveLength(2);
});

test("toolResult attaches to its tool step and does not become a new step", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{
			id: "a1",
			role: "assistant",
			blocks: [{ type: "toolCall", id: "tc1", name: "read", args: { path: "a" } }],
		},
		{
			id: "t1",
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			blocks: [{ type: "text", text: "file contents" }],
		},
	]);

	expect(groups).toHaveLength(1);
	expect(groups[0].kind).toBe("step_group");
	expect(groups[0].steps).toHaveLength(1);
	expect(groups[0].steps[0].kind).toBe("tool");
	expect(groups[0].steps[0].id).toBe("tc1");
	expect(groups[0].steps[0].toolResult?.id).toBe("t1");
});

test("adjacent step-only assistant messages merge into one step group", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{
			id: "a1",
			role: "assistant",
			blocks: [{ type: "thinking", text: "plan" }],
		},
		{
			id: "a2",
			role: "assistant",
			blocks: [{ type: "toolCall", id: "tc1", name: "read", args: {} }],
		},
		{
			id: "a3",
			role: "assistant",
			blocks: [{ type: "thinking", text: "reflect" }],
		},
	]);

	expect(groups).toHaveLength(1);
	expect(groups[0].kind).toBe("step_group");
	expect(groups[0].steps.map((step) => step.kind)).toEqual([
		"thinking",
		"tool",
		"thinking",
	]);
});

test("body text breaks step merging instead of being absorbed", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{
			id: "a1",
			role: "assistant",
			blocks: [{ type: "thinking", text: "plan" }],
		},
		{
			id: "a2",
			role: "assistant",
			blocks: [{ type: "text", text: "visible answer" }],
		},
		{
			id: "a3",
			role: "assistant",
			blocks: [{ type: "toolCall", id: "tc1", name: "read", args: {} }],
		},
	]);

	expect(groups.map((group) => group.kind)).toEqual([
		"step_group",
		"assistant_message",
		"step_group",
	]);
	expect(groups[1].message.id).toBe("a2");
});

test("a text-only message remains body text and never opens a step group", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{ id: "a1", role: "assistant", blocks: [{ type: "text", text: "just an answer" }] },
	]);

	expect(groups).toHaveLength(1);
	expect(groups[0].kind).toBe("assistant_message");
	expect(groups[0].message.id).toBe("a1");
});

test("whitespace-only messages are not rendered at all", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{ id: "u1", role: "user", attribution: "user", blocks: [{ type: "text", text: "  \n " }] },
		{ id: "u2", role: "user", attribution: "user", blocks: [{ type: "text", text: "hi" }] },
		{ id: "a1", role: "assistant", blocks: [{ type: "text", text: "   " }] },
	]);

	expect(groups).toHaveLength(1);
	expect(groups[0].kind).toBe("user_message");
	expect(groups[0].message.id).toBe("u2");
});

test("whitespace text does not become a step or break the step group", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{
			id: "a1",
			role: "assistant",
			blocks: [
				{ type: "thinking", text: "plan" },
				{ type: "text", text: "  \n " },
				{ type: "toolCall", id: "tc1", name: "read", args: {} },
				{ type: "text", text: "final answer" },
			],
		},
	]);

	expect(groups.map((group) => group.kind)).toEqual([
		"step_group",
		"assistant_message",
	]);
	expect(groups[0].steps.map((step) => step.kind)).toEqual(["thinking", "tool"]);
	expect(groups[0].steps.some((step) => step.kind === "text")).toBe(false);
	expect(groups[1].message.blocks.at(-1).text).toBe("final answer");
});

test("a whole turn merges steps; only the final assistant text is body", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{ id: "u1", role: "user", attribution: "user", blocks: [{ type: "text", text: "do the task" }] },
		{
			id: "a1",
			role: "assistant",
			blocks: [{ type: "thinking", text: "plan" }],
		},
		{
			id: "a2",
			role: "assistant",
			blocks: [{ type: "text", text: "let me inspect" }],
		},
		{
			id: "a3",
			role: "assistant",
			blocks: [{ type: "toolCall", id: "tc1", name: "read", args: {} }],
		},
		{
			id: "a4",
			role: "assistant",
			blocks: [{ type: "text", text: "read complete" }],
		},
		{
			id: "a5",
			role: "assistant",
			blocks: [{ type: "thinking", text: "reflect" }],
		},
		{
			id: "a6",
			role: "assistant",
			blocks: [{ type: "toolCall", id: "tc2", name: "write", args: {} }],
		},
		{
			id: "a7",
			role: "assistant",
			blocks: [{ type: "text", text: "final answer" }],
		},
		{ id: "u2", role: "user", attribution: "user", blocks: [{ type: "text", text: "next task" }] },
	]);

	expect(groups.map((group) => group.kind)).toEqual([
		"user_message",
		"step_group",
		"assistant_message",
		"user_message",
	]);

	const stepGroup = groups[1];
	expect(stepGroup.steps.map((step) => step.kind)).toEqual([
		"thinking",
		"text",
		"tool",
		"text",
		"thinking",
		"tool",
	]);
	expect(stepGroup.steps.map((step) => step.text ?? step.name)).toEqual([
		"plan",
		"let me inspect",
		"read",
		"read complete",
		"reflect",
		"write",
	]);

	expect(groups[2].message.id).toBe("a7");
	expect(groups[2].message.blocks.at(-1).text).toBe("final answer");
	expect(groups[3].message.id).toBe("u2");
});
