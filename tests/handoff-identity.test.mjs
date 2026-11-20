import { describe, expect, test } from "bun:test";

import { handoffMessages } from "../src/transcript/fission.mjs";
import { mergeCollapses, mergeModelCaches } from "../src/host/fission-scheduler.mjs";

/**
 * The bug these tests pin: `adopt()` replaces the owner's whole context with
 * `handoffMessages(manager.getBranch(...))`. If a rebuilt boundary carries a
 * fresh `Date.now()`, every historical scope boundary changes bytes the
 * provider already cached, and the prompt cache breaks at the oldest one — the
 * "50% hit rate on the first turn after scope end" report.
 */

let serial = 0;
function entry(type, extra) {
	serial += 1;
	return { id: `e${serial}`, parentId: null, timestamp: 1000 + serial, type, ...extra };
}

function messageEntry(message) {
	return entry("message", { message: { timestamp: 1, ...message } });
}

function boundaryEntry(customType, data) {
	return entry("custom", { customType, data });
}

describe("handoffMessages replay stability", () => {
	test("rebuilding the same journal twice is byte-identical", () => {
		const entries = [
			messageEntry({ role: "user", content: [{ type: "text", text: "start" }] }),
			boundaryEntry("scope.begin", { intent: "work" }),
			messageEntry({
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
			}),
			messageEntry({
				role: "toolResult",
				toolCallId: "c1",
				content: [{ type: "text", text: "done" }],
			}),
			boundaryEntry("scope.end", { status: "closed" }),
		];

		const first = handoffMessages(entries);
		const second = handoffMessages(entries);

		expect(second.length).toBe(first.length);
		for (let index = 0; index < first.length; index += 1) {
			expect(JSON.stringify(second[index])).toBe(JSON.stringify(first[index]));
		}
	});

	test("a boundary keeps the journal timestamp, not the replay clock", () => {
		const begin = boundaryEntry("scope.begin", { intent: "work" });
		const [rebuilt] = handoffMessages([begin]);

		expect(rebuilt.role).toBe("custom");
		expect(rebuilt.timestamp).toBe(begin.timestamp);
	});

	test("a rebuilt boundary is the same object on every replay", () => {
		const begin = boundaryEntry("scope.begin", { intent: "work" });

		expect(handoffMessages([begin])[0]).toBe(handoffMessages([begin])[0]);
	});

	test("a custom message keeps its recorded timestamp too", () => {
		const custom = entry("custom_message", {
			customType: "vibe-mode-context",
			content: "note",
			display: true,
		});
		const [rebuilt] = handoffMessages([custom]);

		expect(rebuilt?.timestamp).toBe(custom.timestamp);
	});
});

describe("promotion state merge", () => {
	test("keeps the owner's collapse records and adds only unseen scopes", () => {
		const owner = [
			{ scopeId: "s1", epoch: 0, collapsed: true },
			{ scopeId: "s2", epoch: 0, collapsed: false },
		];
		const flow = [
			{ scopeId: "s1", epoch: 1, collapsed: false },
			{ scopeId: "s3", epoch: 0, collapsed: false },
		];

		const merged = mergeCollapses(owner, flow);

		expect(merged.map((record) => record.scopeId)).toEqual(["s1", "s2", "s3"]);
		expect(merged[0].epoch).toBe(0);
		expect(merged[0].collapsed).toBe(true);
	});

	test("does not duplicate a record the flow merely cloned", () => {
		const owner = [{ scopeId: "s1", epoch: 0 }];
		const flow = [{ scopeId: "s1", epoch: 0 }];

		expect(mergeCollapses(owner, flow)).toHaveLength(1);
	});

	test("keeps the smaller cache position both sides can prove", () => {
		const owner = {
			"openai/gpt": { cachedUntilPos: 10, lastUsedAt: 5, tokensPerChar: 0.3 },
		};
		const flow = {
			"openai/gpt": { cachedUntilPos: 4, lastUsedAt: 9, tokensPerChar: 0.31 },
			"anthropic/sonnet": { cachedUntilPos: 7, lastUsedAt: 9, tokensPerChar: 0.32 },
		};

		const merged = mergeModelCaches(owner, flow);

		expect(merged["openai/gpt"].cachedUntilPos).toBe(4);
		expect(merged["anthropic/sonnet"].cachedUntilPos).toBe(7);
	});
});
