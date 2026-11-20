import assert from "node:assert/strict";
import test from "node:test";
import { compareFissionFrames, compareMessagePrefix } from "../src/host/fission-session.mjs";

function fixture() {
	const owner = {
		agent: { state: { systemPrompt: ["prompt"] }, promptCacheKey: "cache-a" },
		sessionId: "session-a",
		getEnabledToolNames: () => ["read"],
		getMountedXdevToolNames: () => [],
	};
	const config = {
		toolNames: ["read"],
		mountedToolNames: [],
		systemPrompt: ["prompt"],
		providerPromptCacheKey: "cache-a",
		providerSessionId: "session-a",
	};
	return { owner, config };
}

test("construction checks name their layer and keep the prior frame fields", () => {
	const { owner, config } = fixture();
	const result = compareFissionFrames(owner, config);
	assert.equal(result.layer, "construction");
	assert.equal(result.ok, true);
	assert.deepEqual(result.unavailable, []);
	assert.deepEqual(result.mismatches, []);
	assert.deepEqual(Object.keys(result.frames).sort(), ["promptCacheKey", "systemPrompt", "tools"]);
});

test("an inherited task key is compared as the effective construction key", () => {
	const { owner, config } = fixture();
	delete owner.agent.promptCacheKey;
	delete config.providerPromptCacheKey;
	config.taskPromptCacheKey = "task-a";
	assert.equal(compareFissionFrames(owner, config).ok, true);
});

test("the session fallback does not create a false cache-key mismatch", () => {
	const { owner, config } = fixture();
	delete owner.agent.promptCacheKey;
	config.providerPromptCacheKey = "session-a";
	assert.equal(compareFissionFrames(owner, config).ok, true);
});

test("an unreadable tool view is unavailable instead of equal", () => {
	const { owner, config } = fixture();
	owner.getEnabledToolNames = () => { throw new Error("No tool view"); };
	const result = compareFissionFrames(owner, config);
	assert.equal(result.ok, false);
	assert.deepEqual(result.unavailable, ["tools"]);
	assert.deepEqual(result.mismatches, []);
});

test("matching serialization failures do not count as matching frames", () => {
	const { owner, config } = fixture();
	const circular = [];
	circular.push(circular);
	owner.agent.state.systemPrompt = circular;
	config.systemPrompt = circular;
	const result = compareFissionFrames(owner, config);
	assert.equal(result.ok, false);
	assert.deepEqual(result.unavailable, ["systemPrompt"]);
});

test("message prefix checks do not turn invalid inputs into empty equal arrays", () => {
	assert.equal(compareMessagePrefix(null, null).ok, false);
	const circular = {};
	circular.self = circular;
	assert.equal(compareMessagePrefix([circular], [circular]).ok, false);
	const result = compareMessagePrefix([{ role: "user", content: "A" }], [
		{ role: "user", content: "A" },
		{ role: "assistant", content: "B" },
	]);
	assert.equal(result.layer, "agent-messages");
	assert.equal(result.available, true);
	assert.equal(result.ok, true);
});
