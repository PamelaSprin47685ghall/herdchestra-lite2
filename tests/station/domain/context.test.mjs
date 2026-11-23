// The context projection is a pure decision: it takes plain data and returns a
// patch. These tests pin the projection, the ablation, and the no-mutation rule.

import { describe, expect, test } from "bun:test";

import { beatKey } from "../../../src/transcript/messages.mjs";
import {
	projectContext,
	shouldRebase,
} from "../../../src/station/domain/context.mjs";

describe("projectContext", () => {
	test("never mutates the snapshot or the original messages", () => {
		const original = [
			{ role: "user", content: "hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
		];
		const snapshot = { amends: [] };
		const view = { original, ports: { vibeCompat: "on" } };
		Object.freeze(snapshot);
		Object.freeze(original);
		for (const message of original) Object.freeze(message);
		const before = JSON.stringify({ snapshot, original });

		const result = projectContext(snapshot, view);

		expect(JSON.stringify({ snapshot, original })).toBe(before);
		expect(result.messages).not.toBe(original);
	});

	test("drops every message of an amended beat", () => {
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "a1", name: "read", arguments: {} }],
			timestamp: 1,
		};
		const resultMessage = {
			role: "toolResult",
			toolCallId: "a1",
			content: [{ type: "text", text: "read result" }],
		};
		const keep = { role: "user", content: "keep", timestamp: 2 };
		const result = projectContext(
			{ amends: [beatKey(call)] },
			{ original: [call, resultMessage, keep] },
		);
		expect(result.messages).toEqual([keep]);
	});

	test("rebases only when the host tree tail still matches the outbound tail", () => {
		const tail = { role: "user", content: "same tail", timestamp: 3 };
		const other = { role: "user", content: "other tail", timestamp: 4 };

		expect(
			projectContext(
				{ amends: [] },
				{ original: [tail], tree: [tail], needsRebase: true },
			).rebase,
		).toBe(true);
		expect(
			projectContext(
				{ amends: [] },
				{ original: [tail], tree: [other], needsRebase: true },
			).rebase,
		).toBe(false);
		expect(
			projectContext(
				{ amends: [] },
				{ original: [tail], tree: [tail], needsRebase: false },
			).rebase,
		).toBe(false);
	});

	test("usage carries the rewritten messages and the highest branch frontier", () => {
		const user = { role: "user", content: "hello", timestamp: 1 };
		const vibe = {
			role: "custom",
			customType: "vibe-mode-context",
			content: "drive two worker CLIs",
			timestamp: 2,
		};
		const result = projectContext(
			{ amends: [] },
			{ original: [user, vibe], ports: { vibeCompat: "on" }, modelKey: "m1", header: { h: 1 } },
		);

		expect(result.usage).toEqual({
			key: "m1",
			messages: result.messages,
			header: { h: 1 },
			frontier: 2,
		});
		expect(result.messages[1].content).toContain(
			"direct as many parallel slice/swarm workers",
		);
		expect(
			projectContext(
				{ amends: [] },
				{ original: [user], modelKey: null },
			).usage,
		).toBeNull();
	});

	test("vibeCompat off leaves the custom message untouched", () => {
		const vibe = {
			role: "custom",
			customType: "vibe-mode-context",
			content: "drive two worker CLIs",
			timestamp: 2,
		};
		const result = projectContext(
			{ amends: [] },
			{ original: [vibe], ports: { vibeCompat: "off" } },
		);
		expect(result.messages[0]).toBe(vibe);
	});

	test("empty input is a clean no-op", () => {
		const result = projectContext({}, {});
		expect(result.messages).toEqual([]);
		expect(result.rebase).toBe(false);
		expect(result.usage).toBeNull();
	});

	const turn = [
		{ role: "user", content: [{ type: "text", text: "what did we settle" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "let me recall", signature: "sig" },
				{ type: "text", text: "we settled this" },
			],
		},
	];

	test("prepends the shared opening exchange before the outbound list", () => {
		const user = { role: "user", content: "hello", timestamp: 2 };
		const result = projectContext(
			{ amends: [] },
			{ original: [user], modelKey: "m1", firstTurn: turn },
		);

		expect(result.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(result.messages[0]).toMatchObject({
			role: "user",
			content: turn[0].content,
			timestamp: 1,
			attribution: "user",
		});
		// The host walks an assistant message as real history. Every field it
		// reads must exist, or a DeepSeek-compatible child aborts before its
		// first answer.
		expect(result.messages[1]).toMatchObject({
			role: "assistant",
			content: turn[1].content,
			api: "openai-completions",
			provider: "herdchestra",
			model: "shared-opening",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "stop",
			timestamp: 1,
			attribution: "assistant",
		});
		expect(result.messages[2]).toBe(user);
		expect(result.usage.messages).toBe(result.messages);
		expect(result.usage.frontier).toBe(1);
	});

	test("an empty first turn leaves the list unchanged", () => {
		const user = { role: "user", content: "hello", timestamp: 2 };
		const result = projectContext({}, { original: [user], firstTurn: [] });
		expect(result.messages).toEqual([user]);
	});

	test("the first turn does not count as a branch position", () => {
		const result = projectContext(
			{},
			{ original: [], modelKey: "m1", firstTurn: turn },
		);
		expect(result.messages).toHaveLength(2);
		expect(result.usage.frontier).toBe(0);
	});

	test("keeps a leading developer message ahead of the shared turn", () => {
		const developer = { role: "developer", content: "rules", timestamp: 1 };
		const user = { role: "user", content: "hello", timestamp: 2 };
		const result = projectContext(
			{},
			{ original: [developer, user], firstTurn: turn },
		);
		expect(result.messages.map((message) => message.role)).toEqual([
			"developer",
			"user",
			"assistant",
			"user",
		]);
		expect(result.messages[1].content[0].text).toBe("what did we settle");
	});

	test("strips parts a role cannot carry", () => {
		const withImage = [
			{ role: "user", content: [{ type: "text", text: "q" }, { type: "image", data: "x", mimeType: "image/png" }] },
			{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "toolCall", id: "t", name: "x", arguments: {} }] },
		];
		const result = projectContext({}, { original: [], firstTurn: withImage });
		expect(result.messages[0].content.map((part) => part.type)).toEqual(["text"]);
		expect(result.messages[1].content.map((part) => part.type)).toEqual(["text"]);
	});
});

describe("pure helpers", () => {
	test("shouldRebase refuses a missing tree or a different tail", () => {
		const tail = { role: "user", content: "tail", timestamp: 1 };
		const other = { role: "user", content: "other", timestamp: 2 };
		expect(shouldRebase({ needsRebase: true, tree: [tail], outbound: [tail] })).toBe(true);
		expect(shouldRebase({ needsRebase: true, tree: [other], outbound: [tail] })).toBe(false);
		expect(shouldRebase({ needsRebase: false, tree: [tail], outbound: [tail] })).toBe(false);
		expect(shouldRebase({ needsRebase: true, tree: null, outbound: [tail] })).toBe(false);
	});
});
