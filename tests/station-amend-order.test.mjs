// A failing amend must leave its message and call unmarked, so the scan path
// retries it. Marking before the work made one throw permanent for that path.

import { describe, expect, test } from "bun:test";

import { createToolCallLedger } from "../src/station/domain/tool-call-ledger.mjs";
import { SessionStation } from "../src/station/station.mjs";

const KEY = "amend-1";

function amendMessage() {
	return {
		role: "assistant",
		timestamp: 1,
		content: [
			{
				type: "toolCall",
				id: "amend-1",
				name: "amend",
				arguments: { reflection: "retry after a transient failure" },
			},
		],
	};
}

function fakeStation(targets) {
	const toolCallLedger = createToolCallLedger();
	let persisted = 0;
	return {
		state: {},
		toolCallLedger,
		persist: () => {
			persisted += 1;
		},
		contextMessages: () => [],
		amendBoundary: () => ({ ledger: null, ownerId: null, record: null }),
		findAmendTarget: () => {
			targets.calls += 1;
			return targets.next();
		},
		persistedCount: () => persisted,
	};
}

describe("amend marking order", () => {
	test("a throwing amend leaves the message unmarked for retry", () => {
		const targets = {
			calls: 0,
			next: () => {
				throw new Error("transient amend failure");
			},
		};
		const station = fakeStation(targets);
		const message = amendMessage();

		expect(() =>
			SessionStation.prototype.processAssistantMessage.call(station, message),
		).toThrow("transient amend failure");

		expect(station.toolCallLedger.processed.hasMessage(KEY)).toBe(false);
		expect(station.toolCallLedger.processed.hasCall("amend-1")).toBe(false);
		expect(station.persistedCount()).toBe(0);
	});

	test("the next scan retries an amend that failed, then deduplicates", () => {
		let failure = true;
		const targets = {
			calls: 0,
			next: () =>
				failure
					? (() => {
							failure = false;
							throw new Error("one-shot failure");
						})()
					: { ok: false, code: "AMEND_UNAVAILABLE", reason: "no target" },
		};
		const station = fakeStation(targets);
		const message = amendMessage();

		expect(() =>
			SessionStation.prototype.processAssistantMessage.call(station, message),
		).toThrow("one-shot failure");
		expect(station.toolCallLedger.processed.hasMessage(KEY)).toBe(false);

		SessionStation.prototype.processAssistantMessage.call(station, message);
		expect(station.toolCallLedger.processed.hasCall("amend-1")).toBe(true);
		expect(station.toolCallLedger.processed.hasMessage(KEY)).toBe(true);
		expect(station.persistedCount()).toBe(1);

		// A third delivery of the same message is a no-op.
		SessionStation.prototype.processAssistantMessage.call(station, message);
		expect(targets.calls).toBe(2);
		expect(station.persistedCount()).toBe(1);
	});

	test("the scan path reads the amend half of a scope_context message", () => {
		const targets = {
			calls: 0,
			next: () => ({ ok: false, code: "AMEND_UNAVAILABLE", reason: "no target" }),
		};
		const station = fakeStation(targets);
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{
					type: "toolCall",
					id: "ctx-1",
					name: "scope_context",
					arguments: { amend: { reflection: "drop it" }, pin: { finding: "kept" } },
				},
			],
		};

		SessionStation.prototype.processAssistantMessage.call(station, message);

		expect(targets.calls).toBe(1);
		expect(station.toolCallLedger.processed.hasCall("ctx-1")).toBe(true);
	});

	test("a pin-only scope_context is not an amend target", () => {
		const targets = { calls: 0, next: () => ({ ok: false }) };
		const station = fakeStation(targets);
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{
					type: "toolCall",
					id: "ctx-2",
					name: "scope_context",
					arguments: { pin: { finding: "kept" } },
				},
			],
		};

		SessionStation.prototype.processAssistantMessage.call(station, message);

		expect(targets.calls).toBe(0);
	});
});
