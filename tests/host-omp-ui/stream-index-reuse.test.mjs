import { describe, test, expect } from "bun:test";

// A text delta builds a new messages array on every frame. The render indexes
// (attached tool ids, active streaming message) are cached by array identity,
// so a fresh array used to miss and rescan the whole history at the delta
// rate. The delta path now hands the indexes it already holds; this contract
// locks that the handed-over indexes still describe the new array.

const STORE = "../../host-omp-ui/web/src/protocol/store.ts";
const LIVE = "../../host-omp-ui/web/src/protocol/reducers/live.ts";

function snapshot(overrides = {}) {
	return {
		type: "snapshot",
		session: { id: "s1", title: "Session 1", cwd: "/tmp/work" },
		messages: [
			{
				id: "m1",
				role: "assistant",
				blocks: [
					{ type: "toolCall", id: "t1", name: "read", status: "completed" },
				],
			},
			{ id: "m2", role: "assistant", blocks: [], streaming: true },
		],
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

describe("stream frame render indexes", () => {
	test("a text delta keeps the tool ids and names the streaming message", async () => {
		const { reduceWebState, createInitialWebState } = await import(STORE);
		const { renderIndexes } = await import(LIVE);

		let state = reduceWebState(createInitialWebState(), snapshot());
		state = reduceWebState(state, {
			type: "transcript.delta",
			seq: 2,
			kind: "text_delta",
			messageId: "m2",
			blockIndex: 0,
			delta: "hello",
		});

		const indexes = renderIndexes(state.messages);
		expect(indexes.attachedToolIds.has("t1")).toBe(true);
		expect(indexes.activeStreamingId).toBe("m2");
		// The text landed on the streaming message, and the earlier tool block
		// stayed untouched.
		const streaming = state.messages.find((message) => message.id === "m2");
		expect(streaming.blocks[0].text).toBe("hello");
		expect(state.messages.find((message) => message.id === "m1").blocks[0].id).toBe("t1");
	});

	test("a text delta keeps the previous tool state intact", async () => {
		const { reduceWebState, createInitialWebState } = await import(STORE);
		const before = reduceWebState(createInitialWebState(), snapshot());
		const previousTools = before.toolExecutions;
		const after = reduceWebState(before, {
			type: "transcript.delta", seq: 2, kind: "text_delta",
			messageId: "m2", blockIndex: 0, delta: "hello",
		});
		expect(after.toolExecutions).toBe(previousTools);
		expect(before.messages.find((message) => message.id === "m2").blocks).toEqual([]);
		expect(after.messages.find((message) => message.id === "m2").blocks[0].text).toBe("hello");
	});

	test("the second delta reuses the cached indexes instead of rescanning", async () => {
		const { reduceWebState, createInitialWebState } = await import(STORE);
		const { renderIndexes } = await import(LIVE);

		let state = reduceWebState(createInitialWebState(), snapshot());
		state = reduceWebState(state, {
			type: "transcript.delta",
			seq: 2,
			kind: "text_delta",
			messageId: "m2",
			blockIndex: 0,
			delta: "a",
		});
		const first = renderIndexes(state.messages);

		state = reduceWebState(state, {
			type: "transcript.delta",
			seq: 3,
			kind: "text_delta",
			messageId: "m2",
			blockIndex: 0,
			delta: "b",
		});
		const second = renderIndexes(state.messages);

		// Same attached tool set: the delta path carried it over.
		expect(second.attachedToolIds).toBe(first.attachedToolIds);
		expect(second.activeStreamingId).toBe("m2");
		expect(state.messages.find((message) => message.id === "m2").blocks[0].text).toBe("ab");
	});

	test("positions answer where findIndex would, including duplicates", async () => {
		const { renderIndexes } = await import(LIVE);
		const messages = [
			{ id: "a", role: "user", blocks: [] },
			{ id: "b", role: "assistant", blocks: [], streaming: true },
			// A duplicate id cannot come from the reducer, but the index must
			// still agree with findIndex on the array it describes.
			{ id: "b", role: "assistant", blocks: [] },
		];
		const indexes = renderIndexes(messages);
		expect(indexes.positions.get("a")).toBe(0);
		expect(indexes.positions.get("b")).toBe(1);
		expect(indexes.positions.get("missing")).toBeUndefined();
		expect(indexes.positions.get("b")).toBe(
			messages.findIndex((message) => message.id === "b"),
		);
	});

	test("a delta that supersedes another streaming message still clears it", async () => {
		const { reduceWebState, createInitialWebState } = await import(STORE);

		// Two messages claim to stream. Moving the stream to the second one must
		// clear the first: the fast path skips that pass only when no other
		// message is streaming, so this is the branch that still has to run.
		const seeded = snapshot({
			messages: [
				{ id: "m1", role: "assistant", blocks: [], streaming: true },
				{ id: "m2", role: "assistant", blocks: [], streaming: true },
			],
		});
		let state = reduceWebState(createInitialWebState(), seeded);
		state = reduceWebState(state, {
			type: "transcript.delta",
			seq: 2,
			kind: "text_delta",
			messageId: "m2",
			blockIndex: 0,
			delta: "x",
		});

		expect(state.messages.find((message) => message.id === "m1").streaming).toBe(false);
		expect(state.messages.find((message) => message.id === "m2").streaming).toBe(true);
		expect(state.messages.find((message) => message.id === "m2").blocks[0].text).toBe("x");
	});
});
