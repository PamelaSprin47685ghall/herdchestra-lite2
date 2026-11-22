#!/usr/bin/env bun
/**
 * Exercise the real host Agent, agent-loop, and ExtensionRunner without an API.
 *
 *   OMP_HOST=/path/to/oh-my-pi bun scripts/smoke-context.mjs
 *
 * The host supplies its own mock model. A memory journal replaces disk only.
 * Missing host code or dependencies fail the check; they never count as PASS.
 * This checks request history and per-call markers, not provider cache usage.
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { installContextPreparation, splitRequestHistory } from "../host-omp/src/host/context-preparation.mjs";
import { contextHeaderOf } from "../host-omp/src/host/adapter.mjs";
import { stopAfterScopeReturn } from "../host-omp/src/host/branch-context.mjs";
import { borrowStaleAddon } from "./host-native.mjs";

const HOST = resolve(process.env.OMP_HOST ?? "/home/kunweiz/Desktop/vibe/oh-my-pi");
borrowStaleAddon(HOST, import.meta.path);
const TOOL_ROUNDS = 4;

function hostModule(path) {
	return import(pathToFileURL(resolve(HOST, path)).href);
}

function memoryManager(messages = []) {
	const entries = messages.map((message) => ({ type: "message", message }));
	return {
		entries,
		getCwd: () => HOST,
		getBranch: () => entries.slice(),
		appendMessage(message) {
			entries.push({ type: "message", message });
			return `entry-${entries.length}`;
		},
	};
}

function contextExtension(handler) {
	return {
		path: "herdchestra-context-smoke",
		resolvedPath: "herdchestra-context-smoke",
		handlers: new Map([["context", [handler]]]),
		tools: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		flags: new Map(),
		messageRenderers: new Map(),
	};
}

function makeRunner(ExtensionRunner, manager, model, id, handler) {
	const runtime = {};
	const registry = {
		getAll: () => [model],
		getAvailable: () => [model],
		find: () => model,
	};
	return new ExtensionRunner(
		[contextExtension(handler)],
		runtime,
		HOST,
		manager,
		registry,
		undefined,
		undefined,
		undefined,
		undefined,
		{ kind: "main", id, name: id, depth: 0 },
	);
}

async function exerciseHost(host, start) {
	const { Agent, createMockModel, ExtensionRunner, isPerCallContextMessage, type } = host;
	const id = start === "continue" ? "flow-context-smoke" : "Main";
	const initial = { role: "user", content: "Run four small tool steps, then stop.", timestamp: 1 };
	const manager = memoryManager(start === "continue" ? [initial] : []);
	const frames = [];
	let receiptCount = 0;
	let contextCount = 0;
	let executed = 0;
	let liveContext;
	let extensionMessages;
	const mock = createMockModel({
		responses: [
			...Array.from({ length: TOOL_ROUNDS }, (_, index) => ({
				content: [{ type: "toolCall", id: `step-${index}`, name: "step", arguments: { value: index } }],
			})),
			{ content: ["done"] },
		],
	});
	const runner = makeRunner(ExtensionRunner, manager, mock.model, id, (event) => {
		contextCount += 1;
		extensionMessages = event.messages;
		return { messages: event.messages };
	});
	const agent = new Agent({
		initialState: {
			model: mock.model,
			systemPrompt: ["Context persistence smoke test."],
			messages: start === "continue" ? [initial] : [],
			tools: [{
				name: "step",
				label: "Step",
				description: "Return one local test value.",
				parameters: type({ value: type("number") }),
				concurrency: "exclusive",
				async execute(_callId, params) {
					executed += 1;
					return { content: [{ type: "text", text: `step ${params.value}` }], details: {} };
				},
			}],
		},
		transformContext: async (messages, signal) => {
			const result = await runner.emitContext(messages, signal);
			// Runner reports handler exceptions instead of rethrowing them.
			// Keep assertions outside that boundary so a failure stops the smoke.
			assert.notEqual(extensionMessages, liveContext.messages, "ExtensionRunner must clone the live loop context");
			const receipts = result.filter((message) => message.herdSkill === true);
			assert.equal(receipts.length, frames.length + 1, "the next request lost an earlier receipt");
			for (const message of receipts) {
				assert.equal(isPerCallContextMessage(message), false, "a committed receipt was marked per-call");
			}
			return result;
		},
		streamFn(model, context, options) {
			const frame = structuredClone(context.messages);
			const previous = frames.at(-1);
			if (previous) assert.deepEqual(frame.slice(0, previous.length), previous, "request prefix changed within one loop");
			assert.equal(frame.filter((message) => message.herdSkill === true).length, frames.length + 1);
			frames.push(frame);
			return mock.stream(model, context, options);
		},
	});
	const session = { agent, sessionManager: manager, getAgentId: () => id };
	const station = {
		manager,
		prepareRequest(_ctx, previous) {
			if (previous?.herdSkill === true) return previous;
			receiptCount += 1;
			return {
				role: "developer",
				content: [{ type: "text", text: `Request ${receiptCount}; completed tools ${executed}.` }],
				timestamp: receiptCount,
				attribution: "agent",
				herdSkill: true,
			};
		},
	};
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "message_end") manager.appendMessage(event.message);
	});
	const removePreparation = installContextPreparation(session, { station, ctx: runner.createContext() });
	assert.equal(contextHeaderOf(session)?.tools?.[0]?.parameters?.properties?.value?.type, "number", "the request header lost the host tool schema");
	const removeObserver = agent.addBeforeModelCallHook((_signal, context) => {
		liveContext = context;
		assert.notEqual(context.messages, agent.state.messages, "loop and Agent arrays were aliased");
		const split = splitRequestHistory(context.messages, agent.state.messages);
		assert.deepEqual(split.prefix, agent.state.messages, "the committed loop prefix differs from Agent state");
	});
	try {
		if (start === "continue") await agent.continue();
		else await agent.prompt(initial);
		assert.equal(agent.state.error, undefined, agent.state.error);
		assert.equal(frames.length, TOOL_ROUNDS + 1, "the host did not complete every model request");
		assert.equal(contextCount, frames.length, "the real ExtensionRunner did not inspect every request");
		assert.equal(executed, TOOL_ROUNDS, "the host did not run each tool exactly once");
		assert.equal(receiptCount, frames.length, "a request generated duplicate receipts");
		assert.equal(agent.state.messages.filter((message) => message.herdSkill === true).length, frames.length);
		assert.equal(agent.state.messages.filter((message) => message.role === "assistant").length, frames.length);
		assert.equal(agent.state.messages.filter((message) => message.role === "toolResult").length, TOOL_ROUNDS);
		assert.deepEqual(agent.state.messages, manager.entries.map((entry) => entry.message), "journal and Agent history differ");
		assert.deepEqual(liveContext.messages, agent.state.messages, "loop history differs after completion");
		assert.notEqual(liveContext.messages, agent.state.messages, "loop and Agent arrays share storage");
		console.log(`PASS ${start}: ${frames.length} requests, ${executed} tools, stable prefixes, separate arrays, no per-call Skill`);
	} finally {
		removeObserver();
		removePreparation();
		unsubscribe();
	}
}

async function checkReturnStop({ Agent, createMockModel, type }) {
	const mock = createMockModel({ responses: [
		{ content: [{ type: "toolCall", id: "refused-return", name: "scope_return", arguments: {} }] },
		{ content: [{ type: "toolCall", id: "accepted-return", name: "scope_return", arguments: {} }] },
		{ content: ["this request must never be sent"] },
	] });
	const agent = new Agent({
		initialState: {
			model: mock.model,
			systemPrompt: ["Test scope_return."],
			tools: [{
				name: "scope_return",
				label: "Return",
				description: "Return the child's work.",
				parameters: type({}),
				execute: async (id) => id === "accepted-return"
					? { content: [{ type: "text", text: "Parent accepted" }], details: { accepted: true } }
					: { content: [{ type: "text", text: "Not accepted" }], details: {}, isError: true },
			}],
		},
		streamFn: mock.stream,
	});
	const detach = stopAfterScopeReturn(agent);
	try {
		await agent.prompt({ role: "user", content: "Return this result.", timestamp: Date.now() });
		assert.equal(mock.calls.length, 2, "a refused return must continue; an accepted return must stop");
		assert.equal(agent.state.error, undefined);
		assert.equal(agent.state.messages.at(-1)?.role, "toolResult");
		assert.equal(agent.state.messages.at(-1)?.toolCallId, "accepted-return");
		assert.equal(agent.state.messages.at(-1)?.isError, false);
		assert.equal(agent.state.messages.some((message) => message.stopReason === "aborted"), false);
		console.log("PASS scope_return: accepted tool result is retained; no extra provider call or aborted assistant frame");
	} finally {
		detach();
	}
}

async function checkMarkerControl(host) {
	const { ExtensionRunner, createMockModel, isPerCallContextMessage } = host;
	const message = { role: "user", content: "control", timestamp: 1 };
	const added = { role: "developer", content: [{ type: "text", text: "Temporary context-only note." }], timestamp: 2 };
	const manager = memoryManager([message]);
	const mock = createMockModel({ responses: [{ content: ["done"] }] });
	const runner = makeRunner(ExtensionRunner, manager, mock.model, "Main", (event) => ({ messages: [...event.messages, added] }));
	const result = await runner.emitContext([message]);
	assert.equal(result.length, 2);
	assert.equal(isPerCallContextMessage(result.at(-1)), true, "the per-call marker control did not trigger");
	assert.equal(isPerCallContextMessage(message), false);
	console.log("PASS marker control: the real runner marks a context-only addition as per-call");
}

try {
	if (typeof Bun === "undefined") throw new Error("This check requires Bun and the host's installed dependencies.");
	const [{ Agent }, { createMockModel }, { ExtensionRunner }, { isPerCallContextMessage }, { type }] = await Promise.all([
		hostModule("packages/agent/src/agent.ts"),
		hostModule("packages/ai/src/providers/mock.ts"),
		hostModule("packages/coding-agent/src/extensibility/extensions/runner.ts"),
		hostModule("packages/ai/src/utils/block-symbols.ts"),
		hostModule("packages/omptype/src/index.ts"),
	]);
	for (const [name, value] of Object.entries({ Agent, createMockModel, ExtensionRunner, isPerCallContextMessage, type })) {
		assert.equal(typeof value, "function", `The host export ${name} is unavailable.`);
	}
	const host = { Agent, createMockModel, ExtensionRunner, isPerCallContextMessage, type };
	await checkMarkerControl(host);
	await exerciseHost(host, "prompt");
	await exerciseHost(host, "continue");
	await checkReturnStop(host);
	console.log("PASS context smoke: real host loop and runner; no network API or cache-hit claim");
} catch (error) {
	console.error(`FAIL context smoke: ${error?.stack ?? error}`);
	process.exitCode = 1;
}
