import { describe, expect, test } from "bun:test";
import {
	beatKey,
	exitBeat,
	findBegin,
	findToolCallIndex,
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
				name: "js",
				arguments: { code: 'await api.scope_return({ dafny: "all green" })' },
			},
		],
		[],
		100,
	);
}

function endAssistant() {
	return callMessage(
		[{ id: END_ID, name: "js", arguments: { code: "return 1" } }],
		[],
		200,
	);
}

function beginResult(overrides = {}) {
	return toolResultMessage(BEGIN_ID, "js", {
		content: [{ type: "text", text: "You are now inside this scope." }],
		timestamp: 101,
		details: { scopeId: "scope-1" },
		...overrides,
	});
}

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
