import assert from "node:assert/strict";
import test from "node:test";
import { captureRequestFrame, compareRequestFrames } from "../src/host/request-frames.mjs";

function request(overrides = {}) {
	return {
		namespace: { provider: "example", model: "model-a", api: "messages", cacheKey: "session-a" },
		tools: [{
			name: "read",
			description: "Read a local file.",
			input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		}],
		system: [{ type: "text", text: "Use the supplied tools." }],
		messages: [{ role: "user", content: "Check the file." }],
		cacheSettings: null,
		...overrides,
	};
}

function compare(before, after) {
	return compareRequestFrames(captureRequestFrame(before), captureRequestFrame(after));
}

test("equal requests compare equal without sharing object references", () => {
	const first = request();
	const result = compare(first, structuredClone(first));
	assert.equal(result.status, "compared");
	assert.deepEqual(result.changedFields, []);
	assert.equal(result.namespaceMatches, true);
	assert.equal(result.headMatches, true);
	assert.equal(result.settingsMatch, true);
	assert.equal(result.messages.equal, true);
});

test("a tool schema change is visible when the tool name is unchanged", () => {
	const first = request();
	const second = structuredClone(first);
	second.tools[0].input_schema.required = ["url"];
	const result = compare(first, second);
	assert.deepEqual(result.changedFields, ["tools"]);
	assert.equal(result.headMatches, false);
	assert.equal(result.messages.equal, true);
});

test("tool descriptions and tool order both take part in the frame", () => {
	const first = request({ tools: [{ name: "a", description: "A" }, { name: "b", description: "B" }] });
	const changedText = structuredClone(first);
	changedText.tools[0].description = "Changed";
	assert.deepEqual(compare(first, changedText).changedFields, ["tools"]);
	const changedOrder = structuredClone(first);
	changedOrder.tools.reverse();
	assert.deepEqual(compare(first, changedOrder).changedFields, ["tools"]);
});

test("appended messages preserve the complete prior message prefix", () => {
	const first = request();
	const second = structuredClone(first);
	second.messages.push({ role: "assistant", content: "The file is valid." });
	const result = compare(first, second);
	assert.deepEqual(result.changedFields, ["messages"]);
	assert.deepEqual(result.messages, {
		commonMessages: 1,
		beforeMessages: 1,
		afterMessages: 2,
		previousIsPrefix: true,
		equal: false,
	});
});

test("a message change reports the first changed message boundary", () => {
	const first = request({
		messages: [
			{ role: "user", content: "Start." },
			{ role: "assistant", content: "Read one." },
			{ role: "user", content: "Next." },
		],
	});
	const second = structuredClone(first);
	second.messages[1].content = "Read two.";
	const result = compare(first, second);
	assert.equal(result.messages.commonMessages, 1);
	assert.equal(result.messages.previousIsPrefix, false);
});

test("truncation does not count as preserving the prior prefix", () => {
	const first = request({ messages: [{ role: "user", content: "A" }, { role: "assistant", content: "B" }] });
	const second = request({ messages: [{ role: "user", content: "A" }] });
	const result = compare(first, second);
	assert.equal(result.messages.commonMessages, 1);
	assert.equal(result.messages.previousIsPrefix, false);
});

test("empty conversations have a complete common prefix", () => {
	const result = compare(request({ messages: [] }), request({ messages: [] }));
	assert.equal(result.messages.commonMessages, 0);
	assert.equal(result.messages.previousIsPrefix, true);
	assert.equal(result.messages.equal, true);
});

test("a namespace change is separate from a conversation change", () => {
	const first = request();
	const second = structuredClone(first);
	second.namespace.cacheKey = "session-b";
	const result = compare(first, second);
	assert.deepEqual(result.changedFields, ["namespace"]);
	assert.equal(result.namespaceMatches, false);
	assert.equal(result.headMatches, true);
	assert.equal(result.messages.equal, true);
});

test("a system change is visible even when the message list is stable", () => {
	const first = request();
	const second = structuredClone(first);
	second.system.push({ type: "text", text: "Dynamic receipt." });
	const result = compare(first, second);
	assert.deepEqual(result.changedFields, ["system"]);
	assert.equal(result.headMatches, false);
	assert.equal(result.messages.equal, true);
});

test("cache directives are reported separately from the request content", () => {
	const first = request();
	const second = request({ cacheSettings: { breakpoint: 2, ttl: "5m" } });
	const result = compare(first, second);
	assert.deepEqual(result.changedFields, ["cacheSettings"]);
	assert.equal(result.settingsMatch, false);
	assert.equal(result.headMatches, true);
	assert.equal(result.messages.equal, true);
});

test("unrelated HTTP metadata is outside the explicit projection", () => {
	const first = request({ requestId: "a", headers: { trace: "a" } });
	const second = request({ requestId: "b", headers: { trace: "b" } });
	assert.deepEqual(compare(first, second).changedFields, []);
});

test("captured hashes do not change when their source objects change", () => {
	const source = request();
	const before = captureRequestFrame(source);
	source.system[0].text = "New text.";
	source.messages[0].content = "New message.";
	const result = compareRequestFrames(before, captureRequestFrame(source));
	assert.deepEqual(result.changedFields, ["system", "messages"]);
	assert.equal(Object.isFrozen(before), true);
	assert.equal(Object.isFrozen(before.hashes), true);
	assert.equal(Object.isFrozen(before.messages), true);
	assert.equal(JSON.stringify(before).includes("Check the file."), false);
});

test("serialization failures are unavailable, including matching failures", () => {
	const cycle = {};
	cycle.self = cycle;
	const before = captureRequestFrame(request({ system: cycle }));
	const after = captureRequestFrame(request({ system: cycle }));
	assert.deepEqual(before, { status: "unavailable", field: "system", reason: "SERIALIZE_FAILED" });
	assert.equal(compareRequestFrames(before, after).status, "unavailable");
	assert.equal(captureRequestFrame(request({ messages: [1n] })).status, "unavailable");
});

test("missing projection fields and absent JSON values cannot produce ready frames", () => {
	const missing = request();
	delete missing.cacheSettings;
	assert.deepEqual(captureRequestFrame(missing), {
		status: "unavailable",
		field: "cacheSettings",
		reason: "MISSING_FIELD",
	});
	assert.equal(captureRequestFrame(request({ system: undefined })).status, "unavailable");
	assert.equal(captureRequestFrame(request({ messages: {} })).status, "unavailable");
	assert.equal(captureRequestFrame(null).status, "unavailable");
});

test("a failed projection getter is unavailable", () => {
	const input = request();
	Object.defineProperty(input, "system", { get() { throw new Error("Cannot read"); } });
	assert.deepEqual(captureRequestFrame(input), {
		status: "unavailable",
		field: "system",
		reason: "READ_FAILED",
	});
});

test("invalid supplied frames do not compare equal", () => {
	assert.equal(compareRequestFrames({}, {}).status, "unavailable");
	const damaged = { status: "ready", hashes: {}, messages: [] };
	assert.equal(compareRequestFrames(damaged, damaged).status, "unavailable");
});
