import { describe, test, expect } from "bun:test";

// Red contract for host-omp-ui/web/src/protocol/store.ts.
// Do not run Red. The module is expected to be implemented by the Green slice.
const MODULE = "../../host-omp-ui/web/src/protocol/store.ts";

test("ANSI surface fallback preserves color without interpreting terminal escapes as HTML", async () => {
	const { ansiSegments } = await import("../../host-omp-ui/web/src/protocol/tool-view.ts");
	const segments = ansiSegments('\x1b[31m<unsafe>\x1b[0m plain');
	expect(segments.map((part) => part.text).join('')).toBe('<unsafe> plain');
	expect(segments[0].color).toBe('var(--ansi-red, #cc5555)');
	expect(segments[1].color).toBeUndefined();
});

test("ANSI 256-color foreground and background retain their xterm palette", async () => {
	const { ansiSegments } = await import("../../host-omp-ui/web/src/protocol/tool-view.ts");
	const segments = ansiSegments("\x1b[38;5;196;48;5;244mred\x1b[39;49m plain");
	expect(segments[0]).toMatchObject({ text: "red", color: "rgb(255, 0, 0)", backgroundColor: "rgb(128, 128, 128)" });
	expect(segments[1]).toEqual({ text: " plain" });
});

async function load() {
	try {
		return await import(MODULE);
	} catch (error) {
		throw new Error(`Red contract: ${MODULE} is not implemented yet (${error.message})`);
	}
}

function snapshot(overrides = {}) {
	return {
		type: "snapshot",
		session: { id: "s1", title: "Session 1", cwd: "/tmp/work" },
		messages: [],
		streaming: false,
		todos: [],
		queue: { steering: [], followUp: [] },
		models: [{ provider: "p", id: "m1", name: "Model 1" }],
		thinkingLevel: "high",
		modes: { plan: "inactive" },
		usage: { tokens: 10, contextWindow: 100, percent: 10 },
		draft: { rev: 3, text: "draft", cursor: 5 },
		pendingInteractions: [],
		surface: { sf: "s:web", s: 1, ops: [] },
		notifications: [],
		fenceStatus: "live",
		sessions: [{ id: "s1", title: "Session 1" }],
		artifacts: [{ id: "a1", name: "artifact.txt" }],
		activeArtifactId: "a1",
		...overrides,
	};
}

let loadedApi;

function reduce(state, frame) {
	const api = state.__api ?? loadedApi;
	const next = api.reduceWebState(state, frame);
	// A reducer may build a fresh session state (for example session.select) and
	// therefore drop the test-only __api tag. Reattach it so the next frame in
	// the same synchronous test can still dispatch.
	if (next && next.__api === undefined) next.__api = api;
	return next;
}

async function initial() {
	const api = await load();
	loadedApi = api;
	const state = api.createInitialWebState();
	state.__api = api;
	return state;
}

test("snapshot and older pages retain real and agent user boundaries", async () => {
	const { buildTurnGroups } = await import("../../host-omp-ui/web/src/lib/build-steps.ts");
	const msg = (id, role, attribution) => ({ id, role, attribution, blocks: [{ type: "text", text: id }] });
	let state = reduce(await initial(), snapshot({ messages: [msg("u2", "user", "user"), msg("a2", "assistant")] }));
	state = reduce(state, { type: "history.page", messages: [msg("u1", "user", "user"), msg("fake", "user", "agent"), msg("a1", "assistant")] });
	expect(state.messages.map(m => m.id)).toEqual(["u1", "fake", "a1", "u2", "a2"]);
	expect(state.messages.slice(0, 2).map(m => m.attribution)).toEqual(["user", "agent"]);
	expect(buildTurnGroups(state.messages).filter(g => g.kind === "user").map(g => g.id)).toEqual(["u1", "u2"]);
});

test("tail snapshots preserve paged history only for the same session with an overlap", async () => {
	const msg = (id, text = id) => ({ id, role: "assistant", blocks: [{ type: "text", text }] });
	let state = reduce(await initial(), snapshot({ messages: [msg("b"), msg("c")] }));
	state = reduce(state, { type: "history.page", messages: [msg("a")] });
	state = reduce(state, snapshot({ history: { hasMore: true }, messages: [msg("b", "updated"), msg("c"), msg("d")] }));
	expect(state.messages.map(m => m.id)).toEqual(["a", "b", "c", "d"]);
	expect(state.messages[1].blocks[0].text).toBe("updated");
	state = reduce(state, snapshot({ history: { hasMore: true }, messages: [msg("x")] }));
	// Same session, no overlap, and more history exists: the tail is newer than
	// the paged transcript, so the already-loaded prefix must be preserved.
	expect(state.messages.map(m => m.id)).toEqual(["a", "b", "c", "d", "x"]);
	state = reduce(state, snapshot({ session: { id: "s2" }, history: { hasMore: true }, messages: [msg("x"), msg("y")] }));
	expect(state.messages.map(m => m.id)).toEqual(["x", "y"]);
});

describe("createInitialWebState", () => {
	test("has empty session, messages, interactions, surface, and draft", async () => {
		const state = await initial();
		expect(state.session).toBeNull();
		expect(state.messages).toEqual([]);
		expect(state.openInteractions).toEqual([]);
		expect(state.surfaceDoc).toEqual({});
		expect(state.hasLiveOverlay).toBe(false);
		expect(state.draft).toMatchObject({ rev: 0, text: "" });
	});
});

describe("snapshot", () => {
	test("hydrates session, messages, todos, models, modes, usage, draft, interactions, sessions, and artifacts", async () => {
		let state = await initial();
		state = reduce(
			state,
			snapshot({
				messages: [{ id: "u1", role: "user", blocks: [{ type: "text", text: "hi" }] }],
				todos: [{ content: "ship", status: "in_progress" }],
				pendingInteractions: [{ id: "r1", kind: "form", payload: { html: "<form/>" } }],
			}),
		);

		expect(state.session.id).toBe("s1");
		expect(state.session.title).toBe("Session 1");
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0].blocks[0].text).toBe("hi");
		expect(state.todos[0].content).toBe("ship");
		expect(state.models[0].id).toBe("m1");
		expect(state.thinkingLevel).toBe("high");
		expect(state.modes.plan).toBe("inactive");
		expect(state.usage.percent).toBe(10);
		expect(state.draft).toMatchObject({ rev: 3, text: "draft", cursor: 5 });
		expect(state.openInteractions.map((item) => item.id)).toEqual(["r1"]);
		expect(state.sessions.map((item) => item.id)).toEqual(["s1"]);
		expect(state.artifacts[0].id).toBe("a1");
		expect(state.activeArtifactId).toBe("a1");
	});
});

describe("snapshot streaming normalization", () => {
	test("only the final message may keep streaming; history is flattened", async () => {
		let state = await initial();
		state = reduce(
			state,
			snapshot({
				streaming: true,
				messages: [
					{ id: "a1", role: "assistant", streaming: true, blocks: [{ type: "text", text: "old" }] },
					{ id: "a2", role: "assistant", streaming: true, blocks: [{ type: "text", text: "new" }] },
				],
			}),
		);
		expect(state.messages.map((message) => message.streaming)).toEqual([false, true]);
		expect(state.streaming).toBe(true);
	});

	test("agent busy survives message_end and intermediate snapshots", async () => {
		let state = await initial();
		state = reduce(state, {
			type: "transcript.delta",
			kind: "message_start",
			message: { id: "a1", role: "assistant", blocks: [] },
		});
		state = reduce(state, {
			type: "transcript.delta",
			kind: "text_delta",
			messageId: "a1",
			blockIndex: 0,
			text: "working",
		});
		state = reduce(state, {
			type: "transcript.delta",
			kind: "message_end",
			messageId: "a1",
		});
		expect(state.streaming).toBe(true);

		// The station broadcasts an intermediate snapshot right after message_end.
		// Its meta.busy is still true and no message is streaming: this must not
		// be rendered as idle while the agent is between tool calls.
		state = reduce(
			state,
			snapshot({
				meta: { busy: true },
				messages: [
					{ id: "a1", role: "assistant", streaming: false, blocks: [{ type: "text", text: "working" }] },
				],
			}),
		);
		expect(state.streaming).toBe(true);
		expect(state.meta.busy).toBe(true);

		state = reduce(state, {
			type: "transcript.delta",
			kind: "agent_end",
			messages: [],
		});
		expect(state.streaming).toBe(false);
		expect(state.meta.busy).toBe(false);
	});

	test("an idle snapshot with no streaming message is not busy", async () => {
		let state = await initial();
		state = reduce(
			state,
			snapshot({
				streaming: true,
				messages: [
					{ id: "a1", role: "assistant", streaming: false, blocks: [{ type: "text", text: "done" }] },
				],
			}),
		);
		expect(state.messages[0].streaming).toBe(false);
	});

	test("non-active history messages keep object identity across deltas and message_end", async () => {
		let state = await initial();
		state = reduce(state, snapshot({
			messages: [
				{ id: "h1", role: "user", blocks: [{ type: "text", text: "history" }] },
				{ id: "a0", role: "assistant", blocks: [{ type: "text", text: "old answer" }] },
			],
		}));
		const history = state.messages[0];
		const priorAssistant = state.messages[1];
		state = reduce(state, {
			type: "transcript.delta",
			kind: "message_start",
			message: { id: "a1", role: "assistant", blocks: [] },
		});
		state = reduce(state, {
			type: "transcript.delta",
			kind: "text_delta",
			messageId: "a1",
			blockIndex: 0,
			delta: "new",
		});
		state = reduce(state, { type: "transcript.delta", kind: "message_end", messageId: "a1" });
		expect(state.messages[0]).toBe(history);
		expect(state.messages[1]).toBe(priorAssistant);
	});
});

describe("transcript.delta", () => {
	test("streams text and thinking blocks into one assistant message", async () => {
		let state = await initial();
		state = reduce(state, snapshot());
		state = reduce(state, {
			type: "transcript.delta",
			kind: "message_start",
			message: { id: "a1", role: "assistant", blocks: [] },
		});
		state = reduce(state, {
			type: "transcript.delta",
			kind: "text_delta",
			messageId: "a1",
			blockIndex: 0,
			delta: "Hel",
		});
		state = reduce(state, {
			type: "transcript.delta",
			kind: "text_delta",
			messageId: "a1",
			blockIndex: 0,
			delta: "lo",
		});
		state = reduce(state, {
			type: "transcript.delta",
			kind: "thinking_delta",
			messageId: "a1",
			blockIndex: 1,
			delta: "think",
		});
		state = reduce(state, { type: "transcript.delta", kind: "message_end", messageId: "a1" });

		const message = state.messages.find((item) => item.id === "a1");
		expect(message).toBeDefined();
		expect(message.blocks.find((block) => block.type === "text").text).toBe("Hello");
		expect(message.blocks.find((block) => block.type === "thinking").text).toBe("think");
		expect(message.streaming).toBe(false);
	});

	test("tool and fallback deltas do not mutate earlier states", async () => {
		let state = reduce(await initial(), snapshot({ messages: [{ id: "a1", role: "assistant", streaming: true, blocks: [{ type: "text", text: "before" }] }] }));
		for (const frame of [
			{ kind: "text_delta", delta: " after" },
			{ kind: "tool_start", toolCallId: "t1", toolName: "bash", args: {} },
			{ kind: "tool_update", toolCallId: "t1", partialResult: { output: "one" } },
			{ kind: "tool_end", toolCallId: "t1", result: { output: "done" }, isError: false },
		]) {
			const previous = state;
			const before = JSON.stringify({ messages: previous.messages, tools: previous.toolExecutions });
			state = reduce(state, { type: "transcript.delta", ...frame });
			expect(JSON.stringify({ messages: previous.messages, tools: previous.toolExecutions })).toBe(before);
		}
		expect(state.toolExecutions.t1.status).toBe("completed");
	});

	test("tracks a tool execution from toolcall delta through tool_end", async () => {
		let state = await initial();
		state = reduce(state, snapshot());
		state = reduce(state, {
			type: "transcript.delta",
			kind: "message_start",
			message: { id: "a1", role: "assistant", blocks: [] },
		});
		state = reduce(state, {
			type: "transcript.delta",
			kind: "toolcall_delta",
			messageId: "a1",
			toolCallId: "t1",
			toolName: "bash",
			delta: '{"command":"ls"}',
		});
		state = reduce(state, {
			type: "transcript.delta",
			kind: "tool_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "ls" },
		});
		state = reduce(state, {
			type: "transcript.delta",
			kind: "tool_update",
			toolCallId: "t1",
			partialResult: { output: "a" },
		});
		state = reduce(state, {
			type: "transcript.delta",
			kind: "tool_end",
			toolCallId: "t1",
			result: { output: "a\nb" },
			isError: false,
		});

		const tool = state.toolExecutions.t1;
		expect(tool).toBeDefined();
		expect(tool.name).toBe("bash");
		expect(tool.args).toEqual({ command: "ls" });
		expect(tool.status).toBe("completed");
		expect(tool.result).toEqual({ output: "a\nb" });
		expect(tool.isError).toBe(false);
	});
});

describe("draft.sync", () => {
	test("applies only newer revisions and keeps the origin", async () => {
		let state = await initial();
		state = reduce(state, snapshot());
		state = reduce(state, {
			type: "draft.sync",
			rev: 5,
			origin: "tui",
			text: "new",
			cursor: 3,
		});
		expect(state.draft).toMatchObject({ rev: 5, text: "new", cursor: 3, origin: "tui" });

		state = reduce(state, {
			type: "draft.sync",
			rev: 4,
			origin: "tui",
			text: "stale",
			cursor: 0,
		});
		expect(state.draft.text).toBe("new");
		expect(state.draft.rev).toBe(5);
	});
});

describe("interactions", () => {
	test("opens, then closes a pending interaction with its resolver", async () => {
		let state = await initial();
		state = reduce(state, snapshot());
		state = reduce(state, {
			type: "interaction.open",
			request: { id: "r1", kind: "form", payload: { html: "<form/>" } },
		});
		expect(state.openInteractions.map((item) => item.id)).toContain("r1");

		state = reduce(state, {
			type: "interaction.close",
			requestId: "r1",
			resolvedBy: "tui",
		});
		expect(state.openInteractions.find((item) => item.id === "r1")).toBeUndefined();
		expect(state.resolvedInteractions.r1).toBe("tui");
	});
});

describe("surface.frame", () => {
	test("applies TspOps to the local document and marks live overlays", async () => {
		let state = await initial();
		state = reduce(state, snapshot());
		state = reduce(state, {
			type: "surface.frame",
			sf: "s:web",
			s: 2,
			ops: [{ op: "add", id: "n1", kind: "text", props: { text: "hello" } }],
			overlays: [{ id: "o1", kind: "dialog" }],
		});

		expect(state.surfaceDoc.n1).toBeDefined();
		expect(state.surfaceDoc.n1.kind).toBe("text");
		expect(state.hasLiveOverlay).toBe(true);
		expect(state.overlays.map((item) => item.id)).toEqual(["o1"]);
	});

	test("clears the live overlay flag when the frame has no overlays", async () => {
		let state = await initial();
		state = reduce(state, snapshot());
		state = reduce(state, {
			type: "surface.frame",
			sf: "s:web",
			s: 2,
			ops: [],
			overlays: [{ id: "o1" }],
		});
		expect(state.hasLiveOverlay).toBe(true);

		state = reduce(state, {
			type: "surface.frame",
			sf: "s:web",
			s: 3,
			ops: [],
			overlays: [],
		});
		expect(state.hasLiveOverlay).toBe(false);
	});
});

describe("session selection", () => {
	test("hydrates a confirmed live session switch", async () => {
		let state = await initial();
		state = reduce(state, { type: "session.switched", snapshot: { session: { id: "new" }, messages: [{ id: "n", role: "user", blocks: [{ type: "text", text: "new" }] }] } });
		expect(state.session.id).toBe("new");
		expect(state.messages[0].id).toBe("n");
	});

	test("ignores delayed messages from the previously selected session", async () => {
		let state = await initial();
		state = reduce(state, { type: "session.select", sessionId: "new" });
		state = reduce(state, { type: "snapshot", sessionId: "new", session: { id: "new" }, messages: [{ id: "n", role: "user", blocks: [{ type: "text", text: "new" }] }] });
		state = reduce(state, { type: "transcript.delta", sessionId: "old", kind: "message_start", message: { id: "old-message", role: "assistant", blocks: [] } });
		expect(state.session.id).toBe("new");
		expect(state.messages.map((message) => message.id)).toEqual(["n"]);
		expect(state.liveSession.messages.map((message) => message.id)).toEqual(["n"]);
	});
});

test("ANSI surface applies carriage return, backspace and horizontal cursor movement", async () => {
	const { ansiSegments } = await import("../../host-omp-ui/web/src/protocol/tool-view.ts");
	const text = (value) => ansiSegments(value).map((part) => part.text).join("");
	expect(text("abc\rXY")).toBe("XYc");
	expect(text("abc\bZ")).toBe("abZ");
	expect(text("abcd\x1b[2DZ")).toBe("abZd");
	expect(text("abc\x1b[1GZ\x1b[K")).toBe("Z");
});

test("ANSI cursor counts wide characters and combining marks as terminal cells", async () => {
	const { ansiSegments } = await import("../../host-omp-ui/web/src/protocol/tool-view.ts");
	const text = (value) => ansiSegments(value).map((part) => part.text).join("");
	expect(text("中a\x1b[2DZ")).toBe(" Za");
	expect(text("e\u0301x\x1b[1DZ")).toBe("e\u0301Z");
});

test("ANSI erase does not leave half of a wide character", async () => {
	const { ansiSegments } = await import("../../host-omp-ui/web/src/protocol/tool-view.ts");
	const text = (value) => ansiSegments(value).map((part) => part.text).join("");
	expect(text("中a\x1b[2G\x1b[K")).toBe(" ");
	expect(text("中a\x1b[2G\x1b[1K")).toBe("  a");
});

test("ANSI surface applies vertical cursor positioning and overwrites existing rows", async () => {
	const { ansiSegments } = await import("../../host-omp-ui/web/src/protocol/tool-view.ts");
	const text = (value) => ansiSegments(value).map((part) => part.text).join("");
	expect(text("one\ntwo\x1b[1A\rX")).toBe("Xne\ntwo");
	expect(text("first\nsecond\x1b[1;3HZ")).toBe("fiZst\nsecond");
});

describe("selectors", () => {
	test("selectDisplayGroups separates processing tool turns from final assistant text", async () => {
		const api = await load();
		let state = api.createInitialWebState();
		state = api.reduceWebState(
			state,
			snapshot({
				messages: [
					{ id: "u1", role: "user", blocks: [{ type: "text", text: "hi" }] },
					{
						id: "a1",
						role: "assistant",
						blocks: [{ type: "tool", toolCallId: "t1", name: "bash", status: "completed" }],
					},
					{ id: "a2", role: "assistant", blocks: [{ type: "text", text: "done" }] },
				],
			}),
		);
		const groups = api.selectDisplayGroups(state);
		const kinds = groups.map((group) => group.kind);
		expect(kinds).toContain("processing");
		expect(kinds).toContain("assistant");
	});

	test("selectActiveArtifact returns the active artifact, or null", async () => {
		const api = await load();
		let state = api.createInitialWebState();
		state = api.reduceWebState(
			state,
			snapshot({
				artifacts: [{ id: "a1", name: "one" }, { id: "a2", name: "two" }],
				activeArtifactId: "a2",
			}),
		);
		expect(api.selectActiveArtifact(state).id).toBe("a2");

		state = api.reduceWebState(state, snapshot({ activeArtifactId: null }));
		expect(api.selectActiveArtifact(state)).toBeNull();
	});
});

test("history.page advances hasMore until history is exhausted", async () => {
	const api = await load();
	let state = api.createInitialWebState();
	state = api.reduceWebState(
		state,
		snapshot({
			session: { id: "s1" },
			messages: [
				{ id: "m80", role: "assistant", blocks: [{ type: "text", text: "tail" }] },
			],
			history: { hasMore: true, oldestId: "m80" },
		}),
	);
	expect(state.liveSession.history).toEqual({ hasMore: true, oldestId: "m80" });

	state = api.reduceWebState(state, {
		type: "history.page",
		requestId: "r1",
		messages: [
			{ id: "m70", role: "user", attribution: "user", blocks: [{ type: "text", text: "older" }] },
		],
		hasMore: true,
		oldestId: "m70",
	});
	expect(state.liveSession.history).toEqual({ hasMore: true, oldestId: "m70" });
	expect(state.messages.map((message) => message.id)).toEqual(["m70", "m80"]);

	state = api.reduceWebState(state, {
		type: "history.page",
		requestId: "r2",
		messages: [],
		hasMore: false,
		oldestId: "m70",
	});
	expect(state.liveSession.history).toEqual({ hasMore: false, oldestId: "m70" });
});

test("message-only frames preserve model and thinking selections by reference", async () => {
	const api = await load();
	let state = api.createInitialWebState();
	state = api.reduceWebState(
		state,
		snapshot({
			session: { id: "s1" },
			messages: [
				{ id: "m1", role: "assistant", blocks: [{ type: "text", text: "hello" }] },
			],
			models: [
				{ provider: "kw92", id: "model-a" },
				{ provider: "kw92", id: "model-b" },
			],
			model: { provider: "kw92", id: "model-b" },
			thinkingLevel: "high",
			thinkingLevels: ["off", "medium", "high"],
			modes: { plan: "Plan" },
		}),
	);
	const models = state.models;
	const model = state.model;
	const thinkingLevel = state.thinkingLevel;
	const thinkingLevels = state.thinkingLevels;
	const modes = state.modes;
	const meta = state.meta;

	// A tail snapshot that omits capability fields, plus repeated deltas,
	// must not erase the last known selection nor replace its reference.
	for (let index = 0; index < 3; index += 1) {
		state = api.reduceWebState(
			state,
			snapshot({
				session: { id: "s1" },
				messages: [
					{ id: "m1", role: "assistant", blocks: [{ type: "text", text: `hello ${index}` }] },
				],
				models: [],
				thinkingLevels: [],
				thinkingLevel: "",
				modes: {},
				history: { hasMore: true, oldestId: "m1" },
			}),
		);
		expect(state.models).toBe(models);
		expect(state.model).toBe(model);
		expect(state.thinkingLevel).toBe(thinkingLevel);
		expect(state.thinkingLevels).toBe(thinkingLevels);
		expect(state.modes).toBe(modes);
		expect(state.meta).toBe(meta);
	}

	// An explicit empty meta.update must also keep the previous values.
	state = api.reduceWebState(state, {
		type: "meta.update",
		models: [],
		thinkingLevels: [],
		thinkingLevel: "",
		modes: {},
	});
	expect(state.models).toBe(models);
	expect(state.thinkingLevel).toBe(thinkingLevel);
	expect(state.thinkingLevels).toBe(thinkingLevels);
	expect(state.modes).toBe(modes);
});
