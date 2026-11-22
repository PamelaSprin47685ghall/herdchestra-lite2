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
