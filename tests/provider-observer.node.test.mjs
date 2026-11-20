import assert from "node:assert/strict";
import test from "node:test";
import {
	observeProviderRequest,
	observeProviderResponse,
	providerDiagnostics,
	projectProviderRequest,
	wireProviderObservation,
} from "../src/host/provider-observer.mjs";
import { reset, snapshot } from "../src/host/diagnostics.mjs";

function station() {
	return {
		state: { epoch: 0, amends: [], collapses: [], relay: { generation: 0 } },
		hostBoundaryKey: null,
	};
}

function context(api = "openai-responses", id = "model-a") {
	return { model: { api, id, provider: "provider-a", baseUrl: "https://example.invalid/v1" }, agent: { id: "Main" } };
}

test("latest diagnostics expose successful local reports without inheriting the owner", () => {
	reset();
	const owner = station();
	const payload = responsePayload();
	observeProviderRequest(owner, { payload }, context());
	const report = observeProviderRequest(owner, { payload }, context());
	assert.equal(report.classification, "prefix-preserved");
	assert.deepEqual(providerDiagnostics(owner), [report]);
	assert.deepEqual(providerDiagnostics(Object.create(owner)), []);
	assert.equal(JSON.stringify(providerDiagnostics(owner)).includes("secret user request"), false);
	assert.equal(snapshot().length, 0);
});

function responsePayload() {
	return {
		model: "model-a",
		instructions: "Use the tools.",
		tools: [{ type: "function", name: "read", description: "Read a file.", parameters: { type: "object", required: ["path"] } }],
		input: [{ role: "user", content: "secret user request" }],
		prompt_cache_key: "secret route",
	};
}

function request(target, payload, ctx = context()) {
	return observeProviderRequest(target, { type: "before_provider_request", payload }, ctx);
}

test("Responses projection uses input, full tools, instructions, and the wire model", () => {
	const payload = responsePayload();
	payload.model = "wire-alias";
	payload.client_metadata = { rotating_turn: "not a cache input" };
	const projected = projectProviderRequest(payload, context().model);
	assert.equal(projected.status, "projected");
	assert.equal(projected.wireModelDiffers, true);
	assert.equal(projected.projection.namespace.model, "wire-alias");
	assert.deepEqual(projected.projection.tools, payload.tools);
	assert.deepEqual(projected.projection.messages, payload.input);
	assert.equal(projected.projection.system, payload.instructions);
	assert.equal(Object.hasOwn(projected.projection, "client_metadata"), false);
});

test("sequential requests preserve the previous prompt and ignore transport metadata", () => {
	const target = station();
	const first = responsePayload();
	assert.equal(request(target, first).classification, "baseline");
	const next = structuredClone(first);
	next.input.push({ role: "assistant", content: "Done." });
	next.client_metadata = { rotating_turn: "next" };
	const report = request(target, next);
	assert.equal(report.classification, "prefix-preserved");
	assert.equal(report.comparison.messages.commonMessages, 1);
	assert.equal(report.layer, "provider");
	assert.equal(report.source, "before_provider_request");
	assert.equal(report.finalWire, false);
});

test("a same-name schema change is detected at the provider hook", () => {
	const target = station();
	const first = responsePayload();
	request(target, first);
	const next = structuredClone(first);
	next.tools[0].parameters.required = ["url"];
	const report = request(target, next);
	assert.equal(report.classification, "prefix-changed");
	assert.deepEqual(report.comparison.changedFields, ["tools"]);
});

test("rewritten prior content reports only a message position and hashes", () => {
	reset();
	const target = station();
	const first = responsePayload();
	request(target, first);
	const next = structuredClone(first);
	next.input[0].content = "another secret user request";
	const report = request(target, next);
	assert.equal(report.classification, "prefix-changed");
	assert.equal(report.firstDifference.index, 0);
	assert.match(report.firstDifference.before, /^[a-f0-9]{64}$/);
	const diagnostic = JSON.stringify({ report, records: snapshot(), state: target.providerObservation });
	assert.equal(diagnostic.includes("secret user request"), false);
	assert.equal(diagnostic.includes("secret route"), false);
	assert.equal(diagnostic.includes("Use the tools."), false);
});

test("an amend revision marks a known context change without calling it a cache fault", () => {
	const target = station();
	const first = responsePayload();
	request(target, first);
	target.state.amends.push("beat-1");
	const next = structuredClone(first);
	next.input = [{ role: "user", content: "Kept context." }];
	const report = request(target, next);
	assert.equal(report.classification, "context-rewritten");
	assert.equal(report.historyRevisionChanged, true);
	assert.equal(report.comparison.messages.previousIsPrefix, false);
});

test("fold measurements do not change the history revision, but a fold does", () => {
	const target = station();
	const collapse = { collapsed: false, epoch: 0, beginToolCallId: "begin", endToolCallId: "end", report: "summary", rent: 1 };
	target.state.collapses.push(collapse);
	const first = responsePayload();
	request(target, first);
	collapse.rent = 2;
	assert.equal(request(target, first).classification, "prefix-preserved");
	collapse.collapsed = true;
	assert.equal(request(target, first).classification, "context-rewritten");
});

test("a stateful Responses suffix breaks the comparison baseline", () => {
	const target = station();
	const first = responsePayload();
	request(target, first);
	const suffix = responsePayload();
	suffix.previous_response_id = "response-secret";
	suffix.input = [{ type: "function_call_output", call_id: "call-a", output: "Done" }];
	const report = request(target, suffix);
	assert.equal(report.classification, "partial");
	assert.equal(report.history, "partial");
	assert.equal(report.reason, "PREVIOUS_RESPONSE_REFERENCE");
	assert.equal(report.comparison, null);
	assert.equal(target.providerObservation.frame, null);
	assert.equal(request(target, first).classification, "baseline");
});

test("a stored conversation reference is partial instead of a full prompt", () => {
	const payload = responsePayload();
	payload.conversation = { id: "conversation-a" };
	const report = request(station(), payload);
	assert.equal(report.classification, "partial");
	assert.equal(report.reason, "CONVERSATION_REFERENCE");
});

test("Anthropic cache breakpoints are separate from content and do not alter schemas", () => {
	const schema = { type: "object", properties: { cache_control: { type: "string" } } };
	const first = {
		model: "model-a",
		system: [{ type: "text", text: "System.", cache_control: { type: "ephemeral" } }],
		tools: [{ name: "read", input_schema: schema, cache_control: { type: "ephemeral" } }],
		messages: [{ role: "user", content: [{ type: "text", text: "Question.", cache_control: { type: "ephemeral" } }] }],
	};
	const saved = structuredClone(first);
	const projected = projectProviderRequest(first, context("anthropic-messages").model);
	assert.deepEqual(first, saved);
	assert.deepEqual(projected.projection.tools[0].input_schema, schema);
	assert.equal(Object.hasOwn(projected.projection.tools[0], "cache_control"), false);
	assert.equal(projected.projection.cacheSettings.directives.length, 3);
	const target = station();
	request(target, first, context("anthropic-messages"));
	const next = structuredClone(first);
	delete next.messages[0].content[0].cache_control;
	next.messages.push({ role: "assistant", content: [{ type: "text", text: "Answer.", cache_control: { type: "ephemeral" } }] });
	const report = request(target, next, context("anthropic-messages"));
	assert.equal(report.classification, "settings-changed");
	assert.equal(report.comparison.messages.previousIsPrefix, true);
});

test("Chat Completions keeps system messages in their original ordered list", () => {
	const payload = {
		model: "model-a",
		tools: [],
		messages: [{ role: "system", content: "System." }, { role: "user", content: "Question." }],
	};
	const projected = projectProviderRequest(payload, context("openai-completions").model);
	assert.equal(projected.projection.system, null);
	assert.deepEqual(projected.projection.messages, payload.messages);
	const target = station();
	request(target, payload, context("openai-completions"));
	const next = structuredClone(payload);
	next.messages[0].content = "Changed system.";
	assert.equal(request(target, next, context("openai-completions")).firstDifference.index, 0);
});

test("Google reads the host GenerateContentParameters shape and ignores abortSignal", () => {
	const payload = {
		model: "model-a",
		contents: [{ role: "user", parts: [{ text: "Question." }] }],
		config: {
			systemInstruction: { parts: [{ text: "System." }] },
			tools: [{ functionDeclarations: [{ name: "read", parameters: { type: "OBJECT" } }] }],
			thinkingConfig: { thinkingBudget: 512 },
			abortSignal: new AbortController().signal,
		},
	};
	const projected = projectProviderRequest(payload, context("google-generative-ai").model);
	assert.equal(projected.status, "projected");
	assert.deepEqual(projected.projection.system, payload.config.systemInstruction);
	assert.deepEqual(projected.projection.tools, payload.config.tools);
	assert.deepEqual(projected.projection.messages, payload.contents);
	assert.equal(JSON.stringify(projected.projection).includes("abortSignal"), false);
	assert.equal(request(station(), payload, context("google-generative-ai")).classification, "baseline");
});

test("Google cached content is an external prefix, so the observation is partial", () => {
	const payload = {
		model: "model-a",
		contents: [{ role: "user", parts: [{ text: "Question." }] }],
		config: { cachedContent: "cachedContents/secret" },
	};
	const report = request(station(), payload, context("google-vertex"));
	assert.equal(report.classification, "partial");
	assert.equal(report.reason, "CACHED_CONTENT_REFERENCE");
});

test("unsupported APIs and invalid payloads are explicit and do not claim matching frames", () => {
	const target = station();
	const payload = responsePayload();
	request(target, payload);
	assert.equal(request(target, payload, context("unknown-api")).classification, "unsupported");
	assert.equal(target.providerObservation.frame, null);
	assert.equal(request(target, null).classification, "unavailable");
});

test("an unserializable provider value is unavailable", () => {
	const payload = responsePayload();
	payload.tools[0].parameters.circular = payload.tools[0].parameters;
	const report = request(station(), payload);
	assert.equal(report.classification, "unavailable");
	assert.equal(report.reason, "SERIALIZE_FAILED");
});

test("a flow station does not inherit the owner's previous request", () => {
	const owner = station();
	request(owner, responsePayload());
	const flow = Object.create(owner);
	flow.state = structuredClone(owner.state);
	const flowPayload = responsePayload();
	flowPayload.instructions = "A flow's first request.";
	assert.equal(request(flow, flowPayload).classification, "baseline");
	assert.equal(Object.hasOwn(flow, "providerObservation"), true);
	assert.notEqual(flow.providerObservation, owner.providerObservation);
	assert.equal(owner.providerObservation.sequence, 1);
});

test("response observations omit headers, arbitrary metadata, and unproven usage attribution", () => {
	const target = station();
	const report = observeProviderResponse(target, {
		type: "after_provider_response",
		status: 200,
		requestId: "request-secret",
		headers: { authorization: "secret bearer" },
		metadata: { usage: { cache_read_input_tokens: 999 }, text: "secret response" },
	});
	assert.equal(report.status, 200);
	assert.equal(report.correlated, false);
	assert.equal(report.usageAvailable, false);
	assert.match(report.requestIdHash, /^[a-f0-9]{64}$/);
	assert.equal(JSON.stringify(report).includes("secret"), false);
});

test("host event handlers preserve payloads by returning undefined", async () => {
	const target = station();
	const handlers = new Map();
	const seenContexts = [];
	const pi = { on(name, handler) { handlers.set(name, handler); } };
	const registry = { stationFor(ctx) { seenContexts.push(ctx); return target; } };
	wireProviderObservation(pi, registry);
	assert.deepEqual([...handlers.keys()], ["before_provider_request", "after_provider_response"]);
	const ctx = context();
	const payload = responsePayload();
	const saved = structuredClone(payload);
	// This is the event/return contract of ExtensionRunner.emitBeforeProviderRequest.
	const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);
	assert.equal(result, undefined);
	assert.deepEqual(payload, saved);
	assert.equal(seenContexts[0], ctx);
	assert.equal(target.providerObservation.report.classification, "baseline");
	assert.equal(await handlers.get("after_provider_response")({
		type: "after_provider_response", status: 200, headers: {}, requestId: "a", metadata: {},
	}, ctx), undefined);
	assert.equal(target.providerResponse.source, "after_provider_response");
});

test("an observer failure cannot replace or reject a host request", () => {
	const handlers = new Map();
	wireProviderObservation(
		{ on(name, handler) { handlers.set(name, handler); } },
		{ stationFor() { throw new Error("Private failure detail"); } },
	);
	const result = handlers.get("before_provider_request")({
		type: "before_provider_request", payload: responsePayload(),
	}, context());
	assert.equal(result, undefined);
	const diagnostic = snapshot().at(-1);
	assert.equal(diagnostic.detail.reason, "OBSERVER_FAILED");
	assert.equal(JSON.stringify(diagnostic).includes("Private failure detail"), false);
});
