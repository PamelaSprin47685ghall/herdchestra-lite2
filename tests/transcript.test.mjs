import { describe, expect, test } from "bun:test";
import {
	appendUserTail,
	applyCollapses,
	beatKey,
	exitBeat,
	filterRegrets,
	findBegin,
	findRegretTarget,
	findToolCallIndex,
	finishedReport,
	isCollapsed,
	rewriteVibeMessage,
	toolCalls,
} from "../src/transcript/index.mjs";

const BEGIN_ID = "call_begin";
const END_ID = "call_end";

function fnv1aReference(text) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function textBeat(text, timestamp) {
	return `msg:${timestamp}:${fnv1aReference(text)}`;
}

function textMessage(text, timestamp = 1) {
	return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

function callMessage(calls, extraBlocks = [], timestamp = 1) {
	return {
		role: "assistant",
		content: [...extraBlocks, ...calls.map((call) => ({ type: "toolCall", ...call }))],
		timestamp,
	};
}

function toolResultMessage(toolCallId, toolName = "bash", overrides = {}) {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 1,
		...overrides,
	};
}

function beginAssistant() {
	return callMessage(
		[
			{
				id: BEGIN_ID,
				name: "scope",
				arguments: { begin: { intent: "do the work", budget: { bash: 2 } } },
			},
		],
		[],
		100,
	);
}

function endAssistant() {
	return callMessage(
		[{ id: END_ID, name: "scope", arguments: { end: { report: "all green" } } }],
		[],
		200,
	);
}

function beginResult(overrides = {}) {
	return toolResultMessage(BEGIN_ID, "scope", {
		content: [{ type: "text", text: "You are now inside this scope." }],
		timestamp: 101,
		details: { scopeId: "scope-1" },
		...overrides,
	});
}

function newState(overrides = {}) {
	return { regrets: [], charges: {}, ...overrides };
}

const scope = { id: "scope-1", beginToolCallId: BEGIN_ID };

describe("toolCalls", () => {
	test("returns only tool call blocks with their exact fields", () => {
		const message = callMessage(
			[
				{ id: "call_b", name: "bash", arguments: { command: "ls" }, extra: "drop" },
				{ id: "call_a", name: "read", arguments: { path: "a.txt" } },
			],
			[{ type: "text", text: "before" }],
			7,
		);

		expect(toolCalls(message)).toEqual([
			{ id: "call_b", name: "bash", arguments: { command: "ls" } },
			{ id: "call_a", name: "read", arguments: { path: "a.txt" } },
		]);
	});

	test("returns an empty array for messages without tool calls", () => {
		expect(toolCalls(textMessage("just text", 1))).toEqual([]);
		expect(toolCalls({ role: "user", content: "hello", timestamp: 2 })).toEqual([]);
		expect(toolCalls({ role: "custom", content: "hello" })).toEqual([]);
		expect(toolCalls(undefined)).toEqual([]);
	});
});

describe("beatKey", () => {
	test("uses sorted tool call ids", () => {
		const message = callMessage(
			[
				{ id: "call_c", name: "bash", arguments: {} },
				{ id: "call_a", name: "read", arguments: {} },
				{ id: "call_b", name: "defer", arguments: {} },
			],
			[{ type: "text", text: "ignored" }],
			42,
		);

		expect(beatKey(message)).toBe("tc:call_a,call_b,call_c");
		expect(beatKey(structuredClone(message))).toBe("tc:call_a,call_b,call_c");
	});

	test("tool call beats ignore text and timestamp", () => {
		const first = callMessage(
			[{ id: "call_a", name: "bash", arguments: {} }],
			[{ type: "text", text: "one" }],
			1,
		);
		const second = callMessage(
			[{ id: "call_a", name: "bash", arguments: {} }],
			[{ type: "text", text: "two" }],
			999,
		);

		expect(beatKey(first)).toBe(beatKey(second));
	});

	test("text beats use the timestamp and the FNV-1a content hash", () => {
		const message = textMessage("Plan the next move.", 1234);

		expect(beatKey(message)).toBe(textBeat("Plan the next move.", 1234));
		expect(beatKey(structuredClone(message))).toBe(beatKey(message));
		expect(beatKey(textMessage("Plan the next move.", 1235))).not.toBe(beatKey(message));
		expect(beatKey(textMessage("Plan the next step.", 1234))).not.toBe(beatKey(message));
	});

	test("joins text and thinking blocks in content order", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "weigh options" },
				{ type: "text", text: "pick one" },
				{ type: "thinking", thinking: "verify" },
			],
			timestamp: 50,
		};

		expect(beatKey(message)).toBe(textBeat("weigh options\npick one\nverify", 50));
	});
});

describe("exitBeat", () => {
	test("returns the key, call ids in content order, and calls", () => {
		const message = callMessage(
			[
				{ id: "call_b", name: "bash", arguments: { command: "ls" } },
				{ id: "call_a", name: "read", arguments: { path: "a.txt" } },
			],
			[],
			9,
		);
		const messages = [{ role: "user", content: "go", timestamp: 1 }, message];

		expect(exitBeat(messages, 1)).toEqual({
			key: "tc:call_a,call_b",
			toolCallIds: ["call_b", "call_a"],
			calls: [
				{ id: "call_b", name: "bash", arguments: { command: "ls" } },
				{ id: "call_a", name: "read", arguments: { path: "a.txt" } },
			],
		});
	});
});

describe("findToolCallIndex", () => {
	test("finds the assistant that carries the call", () => {
		const messages = [
			{ role: "user", content: "go", timestamp: 1 },
			callMessage([{ id: "call_a", name: "bash", arguments: {} }], [], 2),
			toolResultMessage("call_a"),
		];

		expect(findToolCallIndex(messages, "call_a")).toBe(1);
		expect(findToolCallIndex(messages, "call_missing")).toBe(-1);
	});

	test("does not match a tool result alone", () => {
		expect(findToolCallIndex([toolResultMessage("call_a")], "call_a")).toBe(-1);
	});
});

describe("findBegin", () => {
	test("returns the begin assistant and its first result", () => {
		const messages = [
			{ role: "user", content: "go", timestamp: 1 },
			beginAssistant(),
			beginResult(),
			endAssistant(),
		];

		const begin = findBegin(messages, BEGIN_ID);
		expect(begin).not.toBeNull();
		expect(begin.assistantIndex).toBe(1);
		expect(begin.resultIndex).toBe(2);
		expect(begin.assistant).toBe(messages[1]);
		expect(begin.result).toBe(messages[2]);
	});

	test("returns null when the result or the call is missing", () => {
		expect(findBegin([beginAssistant()], BEGIN_ID)).toBeNull();
		expect(findBegin([beginAssistant(), beginResult()], "call_missing")).toBeNull();
	});
});

describe("findRegretTarget", () => {
	test("returns the nearest earlier assistant beat in the scope", () => {
		const messages = [
			{ role: "user", content: "go", timestamp: 0 },
			beginAssistant(),
			beginResult(),
			callMessage([{ id: "call_bash", name: "bash", arguments: { command: "ls" } }], [], 110),
			toolResultMessage("call_bash", "bash", { timestamp: 111 }),
			callMessage([{ id: "call_regret", name: "regret", arguments: { reflection: "redo" } }], [], 120),
		];
		const state = newState({
			charges: { call_bash: { scopeId: "scope-1", tool: "bash", amount: 1 } },
		});

		const target = findRegretTarget(state, messages, 5, scope);
		expect(target.ok).toBe(true);
		expect(target.beat.key).toBe("tc:call_bash");
		expect(target.beat.toolCallIds).toEqual(["call_bash"]);
		expect(target.beat.calls).toEqual([
			{ id: "call_bash", name: "bash", arguments: { command: "ls" } },
		]);
		expect(target.toolCalls).toEqual(target.beat.calls);
	});

	test("skips already regretted beats", () => {
		const messages = [
			{ role: "user", content: "go", timestamp: 0 },
			beginAssistant(),
			beginResult(),
			callMessage([{ id: "call_bash", name: "bash", arguments: {} }], [], 110),
			textMessage("newer assistant", 111),
			callMessage([{ id: "call_regret", name: "regret", arguments: {} }], [], 120),
		];
		const state = newState({ regrets: [textBeat("newer assistant", 111)] });

		const target = findRegretTarget(state, messages, 5, scope);
		expect(target.ok).toBe(true);
		expect(target.beat.key).toBe("tc:call_bash");
	});

	test("rejects a candidate at the scope begin assistant", () => {
		const messages = [
			textMessage("older assistant", 5),
			beginAssistant(),
			beginResult(),
			callMessage([{ id: "call_regret", name: "regret", arguments: {} }], [], 120),
		];

		const target = findRegretTarget(newState(), messages, 3, scope);
		expect(target.ok).toBe(false);
		expect(target.code).toBe("SCOPE_BOUNDARY");
	});

	test("rejects a candidate that contains a scope call", () => {
		const messages = [
			beginAssistant(),
			beginResult(),
			endAssistant(),
			toolResultMessage(END_ID, "scope"),
			callMessage([{ id: "call_regret", name: "regret", arguments: {} }], [], 120),
		];

		const target = findRegretTarget(newState(), messages, 4, scope);
		expect(target.ok).toBe(false);
		expect(target.code).toBe("SCOPE_BOUNDARY");
	});

	test("rejects a candidate with a charge from another scope", () => {
		const messages = [
			beginAssistant(),
			beginResult(),
			callMessage(
				[
					{ id: "call_here", name: "bash", arguments: {} },
					{ id: "call_other", name: "read", arguments: {} },
				],
				[],
				110,
			),
			toolResultMessage("call_other", "read", { timestamp: 111 }),
			callMessage([{ id: "call_regret", name: "regret", arguments: {} }], [], 120),
		];
		const state = newState({
			charges: {
				call_here: { scopeId: "scope-1", tool: "bash", amount: 1 },
				call_other: { scopeId: "scope-0", tool: "read", amount: 1 },
			},
		});

		const target = findRegretTarget(state, messages, 4, scope);
		expect(target.ok).toBe(false);
		expect(target.code).toBe("OUTSIDE_SCOPE");
	});

	test("accepts uncharged calls in the candidate", () => {
		const messages = [
			beginAssistant(),
			beginResult(),
			callMessage(
				[{ id: "call_defer", name: "defer", arguments: { intent: "check the docs" } }],
				[],
				110,
			),
			callMessage([{ id: "call_regret", name: "regret", arguments: {} }], [], 120),
		];

		const target = findRegretTarget(newState(), messages, 3, scope);
		expect(target.ok).toBe(true);
		expect(target.beat.key).toBe("tc:call_defer");
	});

	test("rejects NO_BEAT when no earlier assistant exists", () => {
		const messages = [beginAssistant()];

		const target = findRegretTarget(newState(), messages, 0, scope);
		expect(target.ok).toBe(false);
		expect(target.code).toBe("NO_BEAT");
	});

	test("rejects when the scope begin message is absent", () => {
		const messages = [textMessage("anything", 1), textMessage("current", 2)];

		const target = findRegretTarget(newState(), messages, 1, scope);
		expect(target.ok).toBe(false);
		expect(target.code).toBe("SCOPE_BOUNDARY");
	});

	test("requires an active scope", () => {
		const target = findRegretTarget(newState(), [textMessage("x", 1)], 1, null);
		expect(target.ok).toBe(false);
		expect(target.code).toBe("OUTSIDE_SCOPE");
	});
});

describe("filterRegrets", () => {
	test("drops a regretted assistant and its tool results", () => {
		const dropped = callMessage(
			[{ id: "call_drop", name: "bash", arguments: {} }],
			[{ type: "text", text: "drop me" }],
			20,
		);
		const kept = callMessage([{ id: "call_keep", name: "read", arguments: {} }], [], 21);
		const messages = [
			{ role: "user", content: "go", timestamp: 0 },
			dropped,
			toolResultMessage("call_drop"),
			kept,
			toolResultMessage("call_keep", "read"),
			toolResultMessage("call_unknown"),
		];

		const filtered = filterRegrets(messages, ["tc:call_drop"]);

		expect(filtered).toEqual([
			messages[0],
			kept,
			messages[4],
			messages[5],
		]);
		expect(filtered).not.toBe(messages);
		expect(messages).toHaveLength(6);
	});

	test("drops multiple text beats without touching other results", () => {
		const first = textMessage("first", 30);
		const second = textMessage("second", 31);
		const messages = [
			first,
			toolResultMessage("call_keep"),
			second,
			{ role: "user", content: "after", timestamp: 32 },
		];

		const filtered = filterRegrets(messages, [beatKey(first), beatKey(second)]);

		expect(filtered).toEqual([messages[1], messages[3]]);
	});

	test("returns a new array when there is nothing to drop", () => {
		const messages = [textMessage("keep", 1)];
		const filtered = filterRegrets(messages, []);

		expect(filtered).toEqual(messages);
		expect(filtered).not.toBe(messages);
	});
});

describe("applyCollapses", () => {
	function collapsedFixture() {
		return [
			{ role: "user", content: "start", timestamp: 99 },
			beginAssistant(),
			beginResult({ isError: true }),
			callMessage([{ id: "call_bash", name: "bash", arguments: {} }], [], 110),
			toolResultMessage("call_bash", "bash", { timestamp: 111 }),
			endAssistant(),
			toolResultMessage(END_ID, "scope", { timestamp: 201 }),
		];
	}

	test("replaces the begin result and removes messages strictly between", () => {
		const messages = collapsedFixture();
		const collapse = {
			beginToolCallId: BEGIN_ID,
			endToolCallId: END_ID,
			report: "all green",
			createdAt: 300,
		};

		const out = applyCollapses(messages, [collapse]);

		expect(out).toHaveLength(5);
		expect(out[0]).toBe(messages[0]);
		expect(out[1]).toBe(messages[1]);
		expect(out[2]).toEqual({
			...messages[2],
			content: [{ type: "text", text: finishedReport("all green") }],
			isError: false,
		});
		expect(out[2].toolCallId).toBe(BEGIN_ID);
		expect(out[2].toolName).toBe("scope");
		expect(out[2].timestamp).toBe(101);
		expect(out[2].details).toEqual({ scopeId: "scope-1" });
		expect(out[3]).toBe(messages[5]);
		expect(out[4]).toBe(messages[6]);

		expect(messages[2].content).toEqual([{ type: "text", text: "You are now inside this scope." }]);
		expect(messages).toHaveLength(7);
	});

	test("does not collapse across a handoff boundary", () => {
		const boundaries = [
			{
				role: "custom",
				customType: "handoff",
				display: true,
				content: "<handoff-context>\nprevious work\n</handoff-context>",
				timestamp: 150,
			},
			{
				role: "custom",
				customType: "herd-relay-handoff",
				display: true,
				content: [{ type: "text", text: "Handoff complete" }],
				timestamp: 150,
			},
		];
		const collapse = {
			beginToolCallId: BEGIN_ID,
			endToolCallId: END_ID,
			report: "across",
		};
		for (const boundary of boundaries) {
			const messages = collapsedFixture();
			messages.splice(4, 0, boundary);
			const out = applyCollapses(messages, [collapse]);
			expect(out).toEqual(messages);
			expect(out).not.toBe(messages);
		}
	});

	test("does nothing when the end assistant is before the begin result", () => {
		const messages = [beginAssistant(), endAssistant(), beginResult()];
		const collapse = { beginToolCallId: BEGIN_ID, endToolCallId: END_ID, report: "late" };

		const out = applyCollapses(messages, [collapse]);

		expect(out).toEqual(messages);
		expect(out).not.toBe(messages);
	});

	test("does not apply a collapse record from an older epoch", () => {
		const messages = collapsedFixture();
		const collapse = {
			beginToolCallId: BEGIN_ID,
			endToolCallId: END_ID,
			report: "old epoch",
			epoch: 0,
		};

		const out = applyCollapses(messages, [collapse], 1);

		expect(out).toEqual(messages);
		expect(out).not.toBe(messages);
		expect(applyCollapses(messages, [collapse], 0)[2].content).toEqual([
			{ type: "text", text: finishedReport("old epoch") },
		]);
	});

	test("does nothing when the end assistant is absent", () => {
		const messages = [
			{ role: "user", content: "start", timestamp: 1 },
			beginAssistant(),
			beginResult(),
		];
		const collapse = { beginToolCallId: BEGIN_ID, endToolCallId: END_ID, report: "gone" };

		const out = applyCollapses(messages, [collapse]);

		expect(out).toEqual(messages);
		expect(out[2].content).toEqual(messages[2].content);
	});

	test("is idempotent", () => {
		const collapse = {
			beginToolCallId: BEGIN_ID,
			endToolCallId: END_ID,
			report: "all green",
		};
		const once = applyCollapses(collapsedFixture(), [collapse]);
		const twice = applyCollapses(once, [collapse]);

		expect(twice).toEqual(once);
		expect(twice[2].content).toEqual([
			{ type: "text", text: finishedReport("all green") },
		]);
	});

	test("applies multiple collapses in order", () => {
		const firstBeginId = "call_begin_one";
		const firstEndId = "call_end_one";
		const secondBeginId = "call_begin_two";
		const secondEndId = "call_end_two";
		const messages = [
			{ role: "user", content: "start", timestamp: 1 },
			callMessage([{ id: firstBeginId, name: "scope", arguments: {} }], [], 2),
			toolResultMessage(firstBeginId, "scope", { timestamp: 3 }),
			callMessage([{ id: "call_one", name: "bash", arguments: {} }], [], 4),
			toolResultMessage("call_one", "bash", { timestamp: 5 }),
			callMessage([{ id: firstEndId, name: "scope", arguments: {} }], [], 6),
			toolResultMessage(firstEndId, "scope", { timestamp: 7 }),
			callMessage([{ id: secondBeginId, name: "scope", arguments: {} }], [], 8),
			toolResultMessage(secondBeginId, "scope", { timestamp: 9 }),
			callMessage([{ id: "call_two", name: "read", arguments: {} }], [], 10),
			toolResultMessage("call_two", "read", { timestamp: 11 }),
			callMessage([{ id: secondEndId, name: "scope", arguments: {} }], [], 12),
			toolResultMessage(secondEndId, "scope", { timestamp: 13 }),
		];
		const collapses = [
			{ beginToolCallId: firstBeginId, endToolCallId: firstEndId, report: "one" },
			{ beginToolCallId: secondBeginId, endToolCallId: secondEndId, report: "two" },
		];

		const out = applyCollapses(messages, collapses);

		expect(out).toHaveLength(9);
		expect(out[2].content).toEqual([{ type: "text", text: finishedReport("one") }]);
		expect(out[6].content).toEqual([{ type: "text", text: finishedReport("two") }]);
		expect(out.some((message) => message.role === "toolResult" && message.toolCallId === "call_one")).toBe(
			false,
		);
		expect(out.some((message) => message.role === "toolResult" && message.toolCallId === "call_two")).toBe(
			false,
		);
		expect(out.some((message) => message.toolCallId === firstEndId)).toBe(true);
		expect(out.some((message) => message.toolCallId === secondEndId)).toBe(true);
	});

	test("applies only records marked as collapsed", () => {
		const firstBeginId = "call_begin_one";
		const firstEndId = "call_end_one";
		const secondBeginId = "call_begin_two";
		const secondEndId = "call_end_two";
		const messages = [
			{ role: "user", content: "start", timestamp: 1 },
			callMessage([{ id: firstBeginId, name: "scope", arguments: {} }], [], 2),
			toolResultMessage(firstBeginId, "scope", { timestamp: 3 }),
			callMessage([{ id: "call_one", name: "bash", arguments: {} }], [], 4),
			toolResultMessage("call_one", "bash", { timestamp: 5 }),
			callMessage([{ id: firstEndId, name: "scope", arguments: {} }], [], 6),
			toolResultMessage(firstEndId, "scope", { timestamp: 7 }),
			callMessage([{ id: secondBeginId, name: "scope", arguments: {} }], [], 8),
			toolResultMessage(secondBeginId, "scope", { timestamp: 9 }),
			callMessage([{ id: "call_two", name: "read", arguments: {} }], [], 10),
			toolResultMessage("call_two", "read", { timestamp: 11 }),
			callMessage([{ id: secondEndId, name: "scope", arguments: {} }], [], 12),
			toolResultMessage(secondEndId, "scope", { timestamp: 13 }),
		];
		const collapses = [
			{
				beginToolCallId: firstBeginId,
				endToolCallId: firstEndId,
				report: "one",
				collapsed: true,
			},
			{
				beginToolCallId: secondBeginId,
				endToolCallId: secondEndId,
				report: "two",
				collapsed: false,
			},
		];

		const out = applyCollapses(messages, collapses);

		expect(out).toHaveLength(11);
		expect(out[2].content).toEqual([{ type: "text", text: finishedReport("one") }]);
		expect(out.some((message) => message.toolCallId === "call_one")).toBe(false);
		expect(out.some((message) => message.toolCallId === "call_two")).toBe(true);
		expect(out.find((message) => message.toolCallId === secondBeginId)?.content).toEqual([
			{ type: "text", text: "result" },
		]);
	});

	test("isCollapsed matches only the report already on the receipt", () => {
		const collapse = { beginToolCallId: BEGIN_ID, endToolCallId: END_ID, report: "all green" };
		expect(isCollapsed(collapsedFixture(), collapse)).toBe(false);

		const collapsed = applyCollapses(collapsedFixture(), [collapse]);
		expect(isCollapsed(collapsed, collapse)).toBe(true);
		expect(isCollapsed(collapsed, { ...collapse, report: "other" })).toBe(false);
	});
});

describe("applyCollapses with pins", () => {
	const PIN_ID = "call_pin";
	const BASH_ID = "call_bash";
	const collapse = {
		beginToolCallId: BEGIN_ID,
		endToolCallId: END_ID,
		report: "all green",
	};

	function pinnedFixture() {
		return [
			{ role: "user", content: "start", timestamp: 99 },
			beginAssistant(),
			beginResult(),
			callMessage(
				[
					{ id: PIN_ID, name: "pin", arguments: { assumption: "A", conclusion: "C" } },
					{ id: BASH_ID, name: "bash", arguments: { command: "ls" } },
				],
				[{ type: "text", text: "reasoning note" }],
				110,
			),
			toolResultMessage(PIN_ID, "pin", { timestamp: 111 }),
			toolResultMessage(BASH_ID, "bash", { timestamp: 112 }),
			endAssistant(),
			toolResultMessage(END_ID, "scope", { timestamp: 201 }),
		];
	}

	test("keeps pin calls and results after the collapsed scope end beat", () => {
		const messages = pinnedFixture();

		const out = applyCollapses(messages, [collapse]);

		expect(out).toHaveLength(7);
		const pinAssistant = out.find(
			(message) =>
				message.role === "assistant" &&
				toolCalls(message).some((call) => call.id === PIN_ID),
		);
		expect(pinAssistant).toBeDefined();
		expect(toolCalls(pinAssistant)).toEqual([
			{ id: PIN_ID, name: "pin", arguments: { assumption: "A", conclusion: "C" } },
		]);
		expect(
			pinAssistant.content.some(
				(block) => block.type === "text" && block.text === "reasoning note",
			),
		).toBe(true);
		const pinResultIndex = out.findIndex((message) => message.toolCallId === PIN_ID);
		expect(pinResultIndex).toBeGreaterThan(-1);
		expect(out.some((message) => message.toolCallId === BASH_ID)).toBe(false);
		const endResultIndex = out.findIndex((message) => message.toolCallId === END_ID);
		expect(out.indexOf(pinAssistant)).toBeGreaterThan(endResultIndex);
		expect(pinResultIndex).toBe(out.indexOf(pinAssistant) + 1);
	});

	test("does not duplicate a pin result in the begin beat", () => {
		const messages = [
			{ role: "user", content: "start", timestamp: 99 },
			callMessage(
				[
					{ id: BEGIN_ID, name: "scope", arguments: {} },
					{ id: PIN_ID, name: "pin", arguments: { finding: "F" } },
				],
				[],
				100,
			),
			beginResult(),
			toolResultMessage(PIN_ID, "pin", { timestamp: 102 }),
			callMessage([{ id: BASH_ID, name: "bash", arguments: {} }], [], 110),
			toolResultMessage(BASH_ID, "bash", { timestamp: 111 }),
			endAssistant(),
			toolResultMessage(END_ID, "scope", { timestamp: 201 }),
		];

		const out = applyCollapses(messages, [collapse]);

		expect(out.filter((message) => message.toolCallId === PIN_ID)).toHaveLength(1);
		expect(out.some((message) => message.toolCallId === BASH_ID)).toBe(false);
	});

	test("is idempotent with pins", () => {
		const once = applyCollapses(pinnedFixture(), [collapse]);
		const twice = applyCollapses(once, [collapse]);

		expect(twice).toEqual(once);
	});
});

describe("finishedReport", () => {
	test("uses the exact report sentence", () => {
		expect(finishedReport("all green")).toBe(
			"You have finished this scope. Here is your report: all green",
		);
	});
});

describe("rewriteVibeMessage", () => {
	const original =
		"drive two worker CLIs. Run sessions concurrently — normally one `fast` and one `good` on different workstreams. Keep this.";
	const expected =
		"direct as many parallel slice/swarm workers as causality allows. Run independent workstreams concurrently. For decomposable work, use more and more workers aggressively. Keep this.";

	test("applies both replacements to a shallow copy", () => {
		const message = {
			role: "custom",
			customType: "vibe-mode-context",
			content: original,
			display: false,
			timestamp: 5,
		};

		const rewritten = rewriteVibeMessage(message);

		expect(rewritten).not.toBe(message);
		expect(rewritten.content).toBe(expected);
		expect(rewritten.display).toBe(false);
		expect(rewritten.timestamp).toBe(5);
		expect(message.content).toBe(original);
	});

	test("returns the same object when nothing matches", () => {
		const message = {
			role: "custom",
			customType: "vibe-mode-context",
			content: "nothing to change",
			timestamp: 6,
		};

		expect(rewriteVibeMessage(message)).toBe(message);
	});

	test("replaces every occurrence", () => {
		const message = {
			role: "custom",
			customType: "vibe-mode-context",
			content: "drive two worker CLIs and drive two worker CLIs",
		};

		expect(rewriteVibeMessage(message).content).toBe(
			"direct as many parallel slice/swarm workers as causality allows and direct as many parallel slice/swarm workers as causality allows",
		);
	});

	test("ignores other message kinds and non-string content", () => {
		const otherType = {
			role: "custom",
			customType: "other-context",
			content: original,
		};
		const arrayContent = {
			role: "custom",
			customType: "vibe-mode-context",
			content: [{ type: "text", text: original }],
		};
		const user = { role: "user", content: original, timestamp: 7 };

		expect(rewriteVibeMessage(otherType)).toBe(otherType);
		expect(rewriteVibeMessage(arrayContent)).toBe(arrayContent);
		expect(rewriteVibeMessage(user)).toBe(user);
	});
});

describe("appendUserTail", () => {
	test("appends one final user message with a single text block", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
		];
		const before = Date.now();
		const out = appendUserTail(messages, "tail text");
		const after = Date.now();

		expect(out).toHaveLength(2);
		expect(out[0]).toBe(messages[0]);
		expect(out[1].role).toBe("user");
		expect(out[1].content).toEqual([{ type: "text", text: "tail text" }]);
		expect(typeof out[1].timestamp).toBe("number");
		expect(out[1].timestamp).toBeGreaterThanOrEqual(before);
		expect(out[1].timestamp).toBeLessThanOrEqual(after);
		expect(messages).toHaveLength(1);
	});
});
