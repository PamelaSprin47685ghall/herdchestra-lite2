import { describe, expect, test } from "bun:test";

import {
	compareFissionFrames,
	compareMessagePrefix,
} from "../src/host/fission-session.mjs";

function ownerSession(overrides = {}) {
	const owner = {
		agent: { state: { systemPrompt: ["host prompt", "managed block"] }, promptCacheKey: "cache-key-1" },
		getEnabledToolNames: () => ["read", "scope", "todo"],
		getMountedXdevToolNames: () => ["xd://read"],
		systemPrompt: ["stale"],
	};
	return Object.assign(owner, overrides);
}

function config(overrides = {}) {
	return {
		toolNames: ["read", "scope", "todo"],
		mountedToolNames: ["xd://read"],
		systemPrompt: ["host prompt", "managed block"],
		providerPromptCacheKey: "cache-key-1",
		taskPromptCacheKey: "cache-key-1",
		...overrides,
	};
}

describe("owner and flow request-head frames", () => {
	test("identical bytes produce no mismatch", () => {
		const result = compareFissionFrames(ownerSession(), config());
		expect(result.mismatches).toEqual([]);
		expect(Object.keys(result.frames).sort()).toEqual([
			"promptCacheKey",
			"systemPrompt",
			"tools",
		]);
	});

	test("a different tool order is a different frame", () => {
		const result = compareFissionFrames(
			ownerSession(),
			config({ toolNames: ["scope", "read", "todo"] }),
		);
		expect(result.mismatches).toContain("tools");
	});

	test("a stale system prompt is a different frame", () => {
		const result = compareFissionFrames(
			ownerSession(),
			config({ systemPrompt: ["stale"] }),
		);
		expect(result.mismatches).toContain("systemPrompt");
	});

	test("a per-flow cache key is a different frame", () => {
		const result = compareFissionFrames(
			ownerSession(),
			config({ providerPromptCacheKey: "flow-cache" }),
		);
		expect(result.mismatches).toContain("promptCacheKey");
	});
});

describe("message prefix frame", () => {
	const owner = [
		{ role: "user", content: "task" },
		{ role: "assistant", content: [{ type: "toolCall", id: "scope-call" }] },
	];

	test("a flow that starts with the owner prefix matches", () => {
		const flow = [...owner, { role: "custom", customType: "scope.begin" }];
		const result = compareMessagePrefix(owner, flow);
		expect(result.ok).toBe(true);
		expect(result.frame.length).toBe(2);
	});

	test("a changed byte before the boundary breaks the frame", () => {
		const flow = [
			owner[0],
			{ role: "assistant", content: [{ type: "toolCall", id: "scope-call" }], stopReason: "aborted" },
			{ role: "custom", customType: "scope.begin" },
		];
		expect(compareMessagePrefix(owner, flow).ok).toBe(false);
	});
});
