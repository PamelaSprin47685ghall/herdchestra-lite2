import { describe, expect, test } from "bun:test";

import { composeAdoptedMessages } from "../src/host/fission-scheduler.mjs";

/**
 * `adopt()` once replaced the owner's whole context with the heir's array.
 * That array interleaves the batch's structural boundaries, which the owner's
 * conversation never contained, so the provider's cached prefix broke at the
 * oldest boundary. These cases pin the composed form: the owner's own messages
 * survive as the prefix, the receipt replaces its ack, and the boundaries plus
 * the heir's activity follow.
 */

function user(text) {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(callId) {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "scope", arguments: {} }],
		timestamp: 2,
	};
}

function result(callId, text) {
	return {
		role: "toolResult",
		toolCallId: callId,
		content: [{ type: "text", text }],
		timestamp: 3,
	};
}

function boundary(customType) {
	return { role: "custom", customType, content: "{}", display: false, timestamp: 4 };
}

describe("composeAdoptedMessages", () => {
	test("keeps the owner prefix object-identical", () => {
		const owner = [user("start"), assistant("call-1"), result("call-1", "ack")];
		const heir = [user("start"), assistant("call-1"), result("call-1", "receipt")];

		const composed = composeAdoptedMessages(owner, heir, {
			adoptFrom: heir.length,
			callId: "call-1",
			receipt: [result("call-1", "receipt")],
			boundaries: [boundary("scope.begin")],
		});

		expect(composed[0]).toBe(owner[0]);
		expect(composed[1]).toBe(owner[1]);
	});

	test("replaces the ack instead of answering the call twice", () => {
		const owner = [user("start"), assistant("call-1"), result("call-1", "ack")];
		const composed = composeAdoptedMessages(owner, [], {
			callId: "call-1",
			receipt: [result("call-1", "receipt")],
			boundaries: [],
		});

		const results = composed.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0].content[0].text).toBe("receipt");
	});

	test("appends boundaries and the heir tail after the owner prefix", () => {
		const owner = [user("start")];
		const heir = [
			user("start"),
			boundary("scope.begin"),
			{ role: "assistant", content: [], timestamp: 9 },
		];

		const composed = composeAdoptedMessages(owner, heir, {
			adoptFrom: heir.length - 1,
			boundaries: [boundary("scope.begin")],
		});

		expect(composed[0]).toBe(owner[0]);
		expect(composed.map((message) => message.role)).toEqual([
			"user",
			"custom",
			"assistant",
		]);
	});

	test("answers a call exactly once when the owner never held the ack", () => {
		const owner = [user("start"), assistant("call-1")];
		const composed = composeAdoptedMessages(owner, [], {
			callId: "call-1",
			receipt: [result("call-1", "receipt")],
			boundaries: [],
		});

		expect(composed).toHaveLength(3);
		expect(composed.at(-1).toolCallId).toBe("call-1");
	});
});
