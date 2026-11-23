// Transcript normalization is the only place where omp's persisted camelCase
// roles and its live event stream become one ordered model. A mistake here is
// silent: snake_case matching drops every `toolResult`, and the Web UI keeps
// showing assistant text while tool cards vanish.
//
// The module under test is pure. It receives session entries or agent events
// and returns new values; it must not mutate its input.

import { expect, test } from "bun:test";

const MODULE = "../../host-omp-ui/src/station/domain/transcript-model.mjs";

async function load() {
	return import(MODULE);
}

const userEntry = {
	type: "message",
	id: "u1",
	message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
};

const assistantEntry = {
	type: "message",
	id: "a1",
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "plan first" },
			{ type: "text", text: "hello" },
			{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/a.mjs" } },
		],
		timestamp: 2,
	},
};

const toolResultEntry = {
	type: "message",
	id: "t1",
	message: {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "read",
		content: [{ type: "text", text: "export const a = 1;" }],
		timestamp: 3,
	},
};

test("reconstructs every camelCase role and pairs tool results by toolCallId", async () => {
	const { reconstructTranscriptFromEntries } = await load();
	const messages = reconstructTranscriptFromEntries([
		userEntry,
		assistantEntry,
		toolResultEntry,
		{ type: "message", id: "b1", message: { role: "bashExecution", command: "ls", output: "a", exitCode: 0, timestamp: 4 } },
		{ type: "message", id: "p1", message: { role: "pythonExecution", code: "print(1)", output: "1", timestamp: 5 } },
		{ type: "custom_message", id: "c1", customType: "demo.note", content: "note", excludeFromContext: true, timestamp: 6 },
		{ type: "branch_summary", id: "bs1", summary: "old branch", timestamp: 7 },
		{ type: "compaction", id: "cp1", summary: "compacted", timestamp: 8 },
		{ type: "message", id: "f1", message: { role: "fileMention", path: "a.mjs", content: "...", timestamp: 9 } },
	]);

	expect(Array.isArray(messages)).toBe(true);
	const roles = messages.map((message) => message.role);
	for (const role of [
		"user",
		"assistant",
		"toolResult",
		"bashExecution",
		"pythonExecution",
		"custom",
		"branchSummary",
		"compactionSummary",
		"fileMention",
	]) {
		expect(roles).toContain(role);
	}

	const assistant = messages.find((message) => message.role === "assistant");
	const blocks = assistant.blocks;
	expect(blocks.some((block) => block.type === "thinking" && block.text === "plan first")).toBe(true);
	expect(blocks.some((block) => block.type === "text" && block.text === "hello")).toBe(true);
	const toolCall = blocks.find((block) => block.type === "toolCall");
	expect(toolCall).toMatchObject({ id: "tc1", name: "read", args: { path: "src/a.mjs" } });
	// The result is attached to the call, not merely kept as a sibling message.
	expect(JSON.stringify(toolCall.result)).toContain("export const a = 1;");
	expect(messages.find((message) => message.role === "toolResult").toolCallId).toBe("tc1");
});

test("a camelCase toolResult is never silently dropped", async () => {
	const { reconstructTranscriptFromEntries } = await load();
	const messages = reconstructTranscriptFromEntries([assistantEntry, toolResultEntry]);
	const result = messages.find((message) => message.role === "toolResult");
	expect(result).toBeDefined();
	expect(result.toolName).toBe("read");
	expect(result.toolCallId).toBe("tc1");
});

test("streaming deltas accumulate text, thinking and tool arguments in order", async () => {
	const { applyAgentEvent } = await load();
	let state = { messages: [], streaming: null, toolExecutions: {} };

	state = applyAgentEvent(state, {
		type: "message_start",
		message: { id: "a1", role: "assistant", content: [], timestamp: 10 },
	});
	expect(state.streaming.id).toBe("a1");

	state = applyAgentEvent(state, {
		type: "message_update",
		message: { id: "a1", role: "assistant", content: [], timestamp: 10 },
		assistantMessageEvent: { type: "thinking_delta", delta: "plan" },
	});
	state = applyAgentEvent(state, {
		type: "message_update",
		message: { id: "a1", role: "assistant", content: [], timestamp: 10 },
		assistantMessageEvent: { type: "text_delta", delta: "Hel" },
	});
	state = applyAgentEvent(state, {
		type: "message_update",
		message: { id: "a1", role: "assistant", content: [], timestamp: 10 },
		assistantMessageEvent: { type: "text_delta", delta: "lo" },
	});
	state = applyAgentEvent(state, {
		type: "message_update",
		message: { id: "a1", role: "assistant", content: [], timestamp: 10 },
		assistantMessageEvent: { type: "toolcall_start", toolCallId: "tc1", toolName: "read" },
	});
	state = applyAgentEvent(state, {
		type: "message_update",
		message: { id: "a1", role: "assistant", content: [], timestamp: 10 },
		assistantMessageEvent: { type: "toolcall_delta", toolCallId: "tc1", argumentsDelta: '{"path":"src/a.mjs"}' },
	});
	state = applyAgentEvent(state, {
		type: "message_update",
		message: { id: "a1", role: "assistant", content: [], timestamp: 10 },
		assistantMessageEvent: { type: "toolcall_end", toolCallId: "tc1", arguments: { path: "src/a.mjs" } },
	});

	const live = state.streaming;
	expect(live.blocks.some((block) => block.type === "thinking" && block.text === "plan")).toBe(true);
	expect(live.blocks.some((block) => block.type === "text" && block.text === "Hello")).toBe(true);
	const call = live.blocks.find((block) => block.type === "toolCall");
	expect(call).toMatchObject({ id: "tc1", name: "read", args: { path: "src/a.mjs" } });

	state = applyAgentEvent(state, {
		type: "message_end",
		message: { id: "a1", role: "assistant", content: [], timestamp: 10 },
	});
	expect(state.streaming).toBeNull();
	expect(state.messages.some((message) => message.id === "a1")).toBe(true);

	state = applyAgentEvent(state, {
		type: "tool_execution_start",
		toolCallId: "tc1",
		toolName: "read",
		args: { path: "src/a.mjs" },
	});
	state = applyAgentEvent(state, {
		type: "tool_execution_update",
		toolCallId: "tc1",
		toolName: "read",
		partialResult: "export",
	});
	state = applyAgentEvent(state, {
		type: "tool_execution_end",
		toolCallId: "tc1",
		toolName: "read",
		result: { content: [{ type: "text", text: "export const a = 1;" }] },
		isError: false,
	});
	const execution = state.toolExecutions.tc1;
	expect(execution.status).toBe("completed");
	expect(JSON.stringify(execution.result)).toContain("export const a = 1;");
});

test("final user and assistant messages retain the host's finalized content", async () => {
	const { applyAgentEvent } = await load();
	let state = { messages: [], streaming: null, toolExecutions: {} };
	const user = { role: "user", timestamp: 1, content: [{ type: "text", text: "hello" }] };
	state = applyAgentEvent(state, { type: "message_start", message: user });
	state = applyAgentEvent(state, { type: "message_end", message: user });
	expect(state.messages[0].blocks).toEqual([{ type: "text", text: "hello" }]);
	const assistant = { role: "assistant", timestamp: 2, content: [{ type: "text", text: "rewritten" }] };
	state = applyAgentEvent(state, { type: "message_start", message: assistant });
	state = applyAgentEvent(state, { type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", delta: "original" } });
	state = applyAgentEvent(state, { type: "message_end", message: assistant });
	expect(state.messages[1].blocks).toEqual([{ type: "text", text: "rewritten" }]);
});

test("agent_end reconciles the activity context without duplicating history", async () => {
	const { reconcileAgentEnd } = await load();
	const state = {
		messages: [{ id: "a1", role: "assistant", blocks: [{ type: "text", text: "one" }] }],
		streaming: null,
		toolExecutions: {},
	};
	const next = reconcileAgentEnd(state, [
		{ id: "a1", role: "assistant", blocks: [{ type: "text", text: "one" }] },
		{ id: "a2", role: "assistant", blocks: [{ type: "text", text: "two" }] },
	]);
	expect(next.messages.map((message) => message.id)).toEqual(["a1", "a2"]);
	const again = reconcileAgentEnd(next, next.messages);
	expect(again.messages.map((message) => message.id)).toEqual(["a1", "a2"]);
});

test("groups thinking and tool work into a thought group, then the final answer", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{
			id: "a1",
			role: "assistant",
			blocks: [
				{ type: "thinking", text: "plan" },
				{ type: "toolCall", id: "tc1", name: "read", args: { path: "a" }, result: "file" },
			],
		},
		{ id: "t1", role: "toolResult", toolCallId: "tc1", toolName: "read", blocks: [{ type: "text", text: "file" }] },
		{ id: "a2", role: "assistant", blocks: [{ type: "text", text: "done" }] },
	]);
	expect(groups.map((group) => group.kind)).toEqual(["step_group", "assistant_message"]);
	expect(groups[0].steps.map((step) => step.kind)).toEqual(["thinking", "tool"]);
	expect(groups[0].steps[1].toolResult?.id).toBe("t1");
	expect(groups[1].message.id).toBe("a2");
});

test("classifies task, terminal runs and boundary summaries", async () => {
	const { groupTranscriptForDisplay } = await load();
	const groups = groupTranscriptForDisplay([
		{
			id: "a1",
			role: "assistant",
			blocks: [
				{ type: "toolCall", id: "tc1", name: "task", args: { description: "Explore", prompt: "go" } },
			],
		},
		{ id: "b1", role: "bashExecution", command: "ls", output: "a", exitCode: 0 },
		{ id: "cp1", role: "compactionSummary", summary: "compacted" },
	]);
	const kinds = groups.map((group) => group.kind);
	expect(kinds).toContain("subagent_card");
	expect(kinds).toContain("terminal_run");
	expect(kinds).toContain("boundary_summary");
});

test("a delta appended past the last block still respects the 1MB text budget", async () => {
	const { applyDelta } = await import(
		"../../host-omp-ui/web/src/protocol/reducers/transcript.ts"
	);
	const atCap = "x".repeat(1_000_000);
	const state = {
		transcriptSeq: 0,
		streaming: true,
		models: [],
		model: null,
		thinkingLevel: null,
		thinkingLevels: [],
		modes: {},
		meta: { busy: true },
		toolExecutions: {},
		liveSession: {
			messages: [
				{ id: "a1", role: "assistant", blocks: [{ type: "text", text: atCap }] },
			],
			session: {},
		},
	};
	const next = applyDelta(state, {
		type: "transcript.delta",
		kind: "text_delta",
		messageId: "a1",
		blockIndex: 5,
		delta: "tail",
	});
	const block = next.liveSession.messages[0].blocks[0];
	expect(block.text.endsWith("… [truncated]")).toBe(true);
	expect(block.text.length).toBeLessThan(atCap.length + 32);
});
