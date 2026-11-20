/**
 * Replay and adoption checks for the extension's AgentMessage history.
 *
 * These tests check stable replay, adopted messages, and model cache
 * bookkeeping. They do not observe provider payloads or measure cache reuse.
 * Equal serialized messages here do not establish equal provider requests.
 */

import { describe, expect, test } from "bun:test";
import {
	composeAdoptedMessages,
	mergeModelCaches,
} from "../src/host/fission-scheduler.mjs";
import { handoffMessages } from "../src/transcript/fission.mjs";
import { appendHistoryMessage } from "../src/host/hack-context.mjs";
import { rememberSession } from "../src/host/capture.mjs";

function entry(overrides = {}) {
	return {
		type: "custom",
		id: "e1",
		customType: "scope.begin",
		data: { level: 1, intent: "work" },
		display: false,
		...overrides,
	};
}

describe("replayed boundaries", () => {
	test("a missing timestamp replays as the same bytes", () => {
		// A fresh entry object each time: the replay must be stable because the
		// content is stable, not because a WeakMap remembered the first object.
		const first = handoffMessages([entry()]);
		const second = handoffMessages([entry()]);
		expect(first).toHaveLength(1);
		expect(first[0].timestamp).toBe(0);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	test("an ISO timestamp is parsed instead of replaced", () => {
		const iso = "2026-01-02T03:04:05.000Z";
		const [message] = handoffMessages([entry({ timestamp: iso })]);
		expect(message.timestamp).toBe(Date.parse(iso));
	});

	test("an unparseable timestamp is stable", () => {
		const [message] = handoffMessages([entry({ timestamp: "not a date" })]);
		expect(message.timestamp).toBe(0);
	});
});

describe("adopted context", () => {
	test("drops the owner ack and the retirement artifact", () => {
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "scope", arguments: {} }],
		};
		const ack = { role: "toolResult", toolCallId: "call-1", content: "ok" };
		const aborted = {
			role: "assistant",
			stopReason: "aborted",
			errorMessage: "Fission owner retired",
			content: [],
		};
		const receipt = { role: "toolResult", toolCallId: "call-1", content: "receipt" };
		const composed = composeAdoptedMessages([call, aborted, ack], [], {
			callId: "call-1",
			receipt: [receipt],
		});
		expect(composed).toEqual([call, receipt]);
	});
});

describe("model cache bookkeeping", () => {
	test("keeps the heir's later cachedUntilPos after adoption", () => {
		const merged = mergeModelCaches(
			{ "p/m": { cachedUntilPos: 3, lastUsedAt: 1000 } },
			{ "p/m": { cachedUntilPos: 40, lastUsedAt: 2000 } },
		);
		expect(merged["p/m"].cachedUntilPos).toBe(40);
	});
});

describe("skill receipts", () => {
	test("the receipt reaches the live transcript, not just the journal", () => {
		const appended = [];
		const manager = {
			appendMessage: (message) => appended.push(message),
			getBranch: () => appended.map((message, index) => ({
				type: "message",
				id: `e${index}`,
				message,
			})),
		};
		const live = [];
		const source = {
			agent: { state: { messages: live } },
			getAgentId: () => "flow-a",
		};
		rememberSession(source);
		const skill = { role: "developer", content: "skill", herdSkill: true };

		expect(appendHistoryMessage(manager, skill, source)).toBe(true);
		expect(appended).toEqual([skill]);
		expect(live).toEqual([skill]);
	});
});
