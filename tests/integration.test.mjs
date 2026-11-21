/**
 * Fake-host integration: exercises the real hooks and tool executes against a
 * session manager with the same tree semantics as omp.
 */

import { describe, expect, test } from "bun:test";
import { activate } from "../src/main.mjs";
import { stateFor } from "../src/station/index.mjs";
import { createState } from "../src/scope/index.mjs";
import { beginText, skillReceiptText } from "../src/station/texts.mjs";
import { allStagesRan } from "./helpers/stage-flags.mjs";
import { installVibeTools } from "../src/host/index.mjs";
import { finishedReport } from "../src/transcript/index.mjs";
import { beginScope } from "../src/scope/index.mjs";
import { appendRequestMessages, attachRequestPreparation } from "./helpers/request-preparation.mjs";

function makeManager() {
	const entries = [];
	let leafId = null;
	let nextId = 1;
	const id = () => `e${nextId++}`;
	const manager = {
		entries,
		getLeafId: () => leafId,
		getEntry: (entryId) => entries.find((entry) => entry.id === entryId),
		getBranch: (fromId) => {
			const path = [];
			let current = fromId ? entries.find((entry) => entry.id === fromId) : entries.find((entry) => entry.id === leafId);
			while (current) {
				path.unshift(current);
				current = current.parentId ? entries.find((entry) => entry.id === current.parentId) : undefined;
			}
			return path;
		},
		branch: (entryId) => {
			if (!entries.some((entry) => entry.id === entryId)) throw new Error(`missing ${entryId}`);
			leafId = entryId;
		},
		resetLeaf: () => {
			leafId = null;
		},
		appendMessage: (message) => {
			const entry = { type: "message", id: id(), parentId: leafId, message };
			entries.push(entry);
			leafId = entry.id;
			return entry.id;
		},
		appendCustomEntry: (customType, data) => {
			const entry = { type: "custom", customType, data, id: id(), parentId: leafId };
			entries.push(entry);
			leafId = entry.id;
			return entry.id;
		},
		buildSessionContext: () => {
			const messages = [];
			for (const entry of manager.getBranch()) {
				if (entry.type === "message") messages.push(entry.message);
			}
			return { messages };
		},
	};
	return manager;
}

function makeHost() {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const steers = [];
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		sendUserMessage(text, options) {
			steers.push({ text, options });
			return Promise.resolve();
		},
	};
	return { pi, handlers, tools, steers, commands };
}

async function emit(handlers, event, payload, ctx) {
	const results = [];
	for (const handler of handlers.get(event) ?? []) {
		results.push(await handler(payload, ctx));
	}
	return results.find((result) => result !== undefined);
}

function assistant(content, timestamp) {
	return { role: "assistant", content, timestamp: timestamp ?? Date.now() };
}

function call(id, name, args) {
	const withTime =
		name === "scope" && args?.begin && args.begin.time === undefined
			? { ...args, begin: { ...args.begin, time: 60 } }
			: args;
	return { type: "toolCall", id, name, arguments: withTime };
}

function toolResult(id, name, text, isError = false) {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

test("broadcast renderer displays the complete message", async () => {
	const host = makeHost();
	let renderer;
	host.pi.pi = { Text: class { constructor(text) { this.text = text; } } };
	host.pi.registerMessageRenderer = (type, render) => {
		if (type === "fission.broadcast") renderer = render;
	};
	await activate(host.pi);
	const message = { content: "(broadcast to 2 flows)\n\noperator note" };
	expect(renderer(message).text).toBe(message.content);
	expect(renderer({ content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }).text).toBe("first\nsecond");
});

async function start(manager, options = {}) {
	const host = makeHost();
	await activate(host.pi);
	const ctx = { sessionManager: manager };
	const session = {
		sessionManager: manager,
		agent: {
			state: { messages: manager.buildSessionContext().messages, systemPrompt: [], tools: [...host.tools.values()] },
			beforeToolCall({ toolCall, args }) {
				return emit(host.handlers, "tool_call", {
					type: "tool_call", toolCallId: toolCall.id,
					toolName: toolCall.name, input: args,
				}, ctx);
			},
		},
	};
	attachRequestPreparation(session, ctx);
	stateFor(ctx).state.stageFlags = allStagesRan();
	const user = { role: "user", content: "do the task", timestamp: Date.now() };
	manager.appendMessage(user);
	appendRequestMessages(ctx, user);
	if (options.beforeStart !== false) {
		const prepared = await emit(host.handlers, "before_agent_start", { systemPrompt: session.agent.state.systemPrompt }, ctx);
		if (prepared?.systemPrompt) session.agent.state.systemPrompt = prepared.systemPrompt;
	}
	return { host, ctx, session };
}

async function runAssistant(host, ctx, message) {
	const manager = ctx.sessionManager;
	await emit(host.handlers, "assistant_message", { type: "assistant_message", message }, ctx);
	manager.appendMessage(message);
	appendRequestMessages(ctx, message);
	const results = [];
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const decision = await emit(
			host.handlers,
			"tool_call",
			{ type: "tool_call", toolCallId: block.id, toolName: block.name, input: block.arguments },
			ctx,
		);
		if (decision?.block) {
			const result = toolResult(block.id, block.name, decision.reason, true);
			manager.appendMessage(result);
			appendRequestMessages(ctx, result);
			results.push({ result, blocked: true });
			continue;
		}
		const tool = host.tools.get(block.name);
		const nativeText = block.name === "read" ? `read:${block.arguments?.path}` : `${block.name} ok`;
		const output = tool
			? await tool.execute(block.id, block.arguments, undefined, undefined, ctx)
			: { content: [{ type: "text", text: nativeText }] };
		const result = toolResult(block.id, block.name, output.content[0].text, Boolean(output.isError));
		manager.appendMessage(result);
		appendRequestMessages(ctx, result);
		results.push({ result, blocked: false, output });
	}
	return results;
}

async function outbound(host, ctx) {
	const messages = await ctx.requestPreparation.prepare();
	const result = await emit(host.handlers, "context", { type: "context", messages }, ctx);
	return result?.messages ?? messages;
}

test("before_agent_start installs preparation before the first context projection", async () => {
	const manager = makeManager();
	const { host, ctx, session } = await start(manager, { beforeStart: false });
	expect(ctx.requestPreparation.hooks.size).toBe(0);
	const first = await emit(host.handlers, "before_agent_start", { systemPrompt: [] }, ctx);
	if (first?.systemPrompt) session.agent.state.systemPrompt = first.systemPrompt;
	expect(ctx.requestPreparation.hooks.size).toBe(1);
	const messages = await outbound(host, ctx);
	const receipt = ctx.agentMessages.at(-1);
	expect(receipt.herdSkill).toBe(true);
	expect(messages.at(-1)).toEqual(receipt);
	expect(session.agent.state.messages.at(-1)).toBe(receipt);
	expect(ctx.agentMessages).not.toBe(session.agent.state.messages);
	await emit(host.handlers, "before_agent_start", { systemPrompt: session.agent.state.systemPrompt }, ctx);
	await outbound(host, ctx);
	expect(ctx.requestPreparation.hooks.size).toBe(1);
	expect(ctx.agentMessages.at(-1)).toBe(receipt);
	expect(manager.getBranch().filter((entry) => entry.message?.herdSkill)).toHaveLength(1);
});

function texts(messages) {
	return messages.map((message) =>
		typeof message.content === "string"
			? message.content
			: (message.content ?? []).map((block) => block.text ?? block.thinking ?? "").join(""),
	);
}

// The only live begin is a fission batch, which the scheduler opens in flow
// sessions. These fake-host tests cover what happens to a scope that is already
// open, so a historical scope is seeded directly: its state entry, its
// persisted boundary, and its begin call on the branch.
function seedScope(ctx, { id, intent, stage = "direct-execution", budget = { read: 1 }, time = 60 }) {
	const opened = beginScope(stateFor(ctx).state, { toolCallId: id, intent, stage, budget, time });
	expect(opened.ok).toBe(true);
	const manager = ctx.sessionManager;
	manager.appendCustomEntry("scope.begin", { intent, stage, budget: { ...budget } });
	const message = assistant([call(id, "scope", { begin: {} })]);
	const result = toolResult(id, "scope", "Scope opened.");
	manager.appendMessage(message);
	manager.appendMessage(result);
	appendRequestMessages(ctx, message, result);
	return opened.scope;
}

describe("scope lifecycle", () => {
	test("transitions between scopes and retains elder work as a hot workbench", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "b1", intent: "first", stage: "acceptance-cases" });
		await runAssistant(host, ctx, assistant([call("r1", "read", { path: "first" })]));
		const firstEnd = await runAssistant(host, ctx, assistant([call("t1", "scope", { end: true })]));
		expect(firstEnd[0].output.content[0].text).toContain("Scope closed.");
		expect(firstEnd[0].output.content[0].text).toContain("outside all scopes");
		seedScope(ctx, { id: "b2", intent: "second", stage: "architecture-design" });
		const read = await runAssistant(host, ctx, assistant([call("r2", "read", { path: "second" })]));
		expect(read[0].blocked).toBe(false);
		await runAssistant(host, ctx, assistant([call("t2", "scope", { end: true })]));
		seedScope(ctx, { id: "b3", intent: "third", stage: "orchestration-plan" });
		let joined = texts(await outbound(host, ctx)).join("\n");
		// No cost/watermark pressure in this fake host: no fold happens, so the
		// archived elder keeps its full interior instead of a receipt.
		expect(joined).toContain("read:first");
		expect(joined).toContain("read:second");
		expect(joined).not.toContain(finishedReport("first done"));
		expect(joined).not.toContain(finishedReport("second done"));
		await runAssistant(host, ctx, assistant([call("r3", "read", { path: "third" })]));
		const end = await runAssistant(host, ctx, assistant([call("e3", "scope", { end: true })]));
		expect(end[0].output.isError).not.toBe(true);
		joined = texts(await outbound(host, ctx)).join("\n");
		expect(joined).toContain("read:second");
		expect(joined).toContain("read:third");
		expect(joined).not.toContain(finishedReport("second done"));
	});

	test("rejects invalid transitions without closing the active scope", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const outside = await runAssistant(host, ctx, assistant([call("t0", "scope", {
			end: true,
		})]));
		expect(outside[0].output.content[0].text).toContain("NOT_IN_SCOPE");
		seedScope(ctx, { id: "b1", intent: "first" });
		const invalid = await runAssistant(host, ctx, assistant([call("t1", "scope", {
			end: "yes",
		})]));
		expect(invalid[0].output.isError).toBe(true);
		expect(invalid[0].output.content[0].text).toContain("INVALID_ARGUMENT");
		const read = await runAssistant(host, ctx, assistant([call("r1", "read", { path: "still first" })]));
		expect(read[0].blocked).toBe(false);
	});

	test("begin, budget block, deferred collapse, outside tail", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);

		seedScope(ctx, { id: "c1", intent: "inspect config" });
		const first = await runAssistant(
			host,
			ctx,
			assistant([
				call("c2", "read", { path: "config-one" }),
			]),
		);
		expect(first[0].blocked).toBe(false);

		const second = await runAssistant(host, ctx, assistant([call("c3", "read", { path: "config-two" })]));
		expect(second[0].blocked).toBe(true);
		expect(second[0].result.content[0].text).toContain('Tool "read" has no budget left');

		const third = await runAssistant(
			host,
			ctx,
			assistant([call("c4", "scope", { end: true })]),
		);
		expect(third[0].blocked).toBe(false);
		expect(third[0].output.content[0].text).toContain("Scope closed");
		expect(third[0].output.content[0].text).toContain("You are outside all scopes.");

		// The freshest scope keeps its turns: nothing is rewritten yet.
		const branchAfterFirstEnd = manager.getBranch();
		const messagesAfterFirstEnd = branchAfterFirstEnd
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		expect(texts(messagesAfterFirstEnd).join("\n")).not.toContain(
			"You have finished this scope. Here is your report: done: config inspected",
		);
		expect(
			messagesAfterFirstEnd.some(
				(message) =>
					message.role === "assistant" && message.content.some((block) => block.id === "c3"),
			),
		).toBe(true);

		const viewAfterFirstEnd = await outbound(host, ctx);
		const joinedAfterFirstEnd = texts(viewAfterFirstEnd).join("\n");
		expect(joinedAfterFirstEnd).not.toContain("You have finished this scope. Here is your report:");
		expect(joinedAfterFirstEnd).toContain('Tool "read" has no budget left');

		// The next scope end collapses the previous scope, not itself.
		seedScope(ctx, { id: "d1", intent: "second pass" });
		await runAssistant(host, ctx, assistant([call("d2", "read", { path: "config-three" })]));
		const finalEnd = await runAssistant(
			host,
			ctx,
			assistant([call("d3", "scope", { end: true })]),
		);
		expect(finalEnd[0].output.content[0].text).not.toContain("was collapsed");

		const branch = manager.getBranch();
		const messages = branch.filter((entry) => entry.type === "message").map((entry) => entry.message);
		expect(texts(messages).join("\n")).toContain("read:config-one");
		expect(texts(messages).join("\n")).not.toContain(finishedReport("done: config inspected"));
		expect(
			messages.some(
				(message) =>
					message.role === "assistant" && message.content.some((block) => block.id === "c3"),
			),
		).toBe(true);
		expect(
			messages.some(
				(message) =>
					message.role === "assistant" && message.content.some((block) => block.id === "d2"),
			),
		).toBe(true);

		const view = await outbound(host, ctx);
		const joined = texts(view).join("\n");
		expect(joined).toContain("read:config-one");
		expect(joined).not.toContain(finishedReport("second pass done"));
		expect(joined).toContain("read:config-one");
		expect(joined).not.toContain("read:config-two");
		expect(joined).toContain("read:config-three");
		expect(joined).toContain("You are outside all scopes.");
		expect(joined).toContain("Simple mode: this task runs without a ledger");
		expect(joined).not.toContain("no todo ledger");
	});

	test("collapses one scope behind across three scopes", async () => {
		// Retained as a lifecycle regression: with no measured usage or pricing
		// the economics never cross the fold threshold, so all elders stay hot.
		const manager = makeManager();
		const { host, ctx } = await start(manager);

		seedScope(ctx, { id: "b1", intent: "one" });
		await runAssistant(host, ctx, assistant([call("r1", "read", { path: "one" })]));
		await runAssistant(host, ctx, assistant([call("e1", "scope", { end: true })]));
		seedScope(ctx, { id: "b2", intent: "two" });
		await runAssistant(host, ctx, assistant([call("r2", "read", { path: "two" })]));
		await runAssistant(host, ctx, assistant([call("e2", "scope", { end: true })]));

		let joined = texts(await outbound(host, ctx)).join("\n");
		expect(joined).toContain("read:one");
		expect(joined).toContain("read:two");
		expect(joined).not.toContain(finishedReport("scope one done"));
		expect(joined).not.toContain(finishedReport("scope two done"));

		seedScope(ctx, { id: "b3", intent: "three" });
		await runAssistant(host, ctx, assistant([call("r3", "read", { path: "three" })]));
		await runAssistant(host, ctx, assistant([call("e3", "scope", { end: true })]));

		joined = texts(await outbound(host, ctx)).join("\n");
		expect(joined).toContain("read:one");
		expect(joined).toContain("read:two");
		expect(joined).not.toContain(finishedReport("scope one done"));
		expect(joined).not.toContain(finishedReport("scope two done"));
		expect(joined).not.toContain(finishedReport("scope three done"));
		expect(joined).toContain("read:two");
		expect(joined).toContain("read:three");
	});

	test("outside tools are blocked", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const result = await runAssistant(host, ctx, assistant([call("c1", "read", { path: "a" })]));
		expect(result[0].blocked).toBe(true);
		expect(result[0].result.content[0].text).toContain("Outside all scopes");
		const view = await outbound(host, ctx);
		expect(texts(view).join("\n")).toContain("You are outside all scopes.");
	});

	test("nudges a natural stop inside a scope", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "b1", intent: "work" });
		const stop = await runAssistant(
			host,
			ctx,
			assistant([{ type: "text", text: "Done." }]),
		);
		expect(stop).toEqual([]);
		expect(host.steers.length).toBe(1);
		expect(host.steers[0].text).toContain("still inside scope level 1");
		expect(host.steers[0].text).toContain(
			"Do not write the final user-facing conclusion",
		);
	});

	test("does not nudge a final answer outside all scopes in simple mode", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		await runAssistant(
			host,
			ctx,
			assistant([{ type: "text", text: "Final answer." }]),
		);
		expect(host.steers.length).toBe(0);
	});

	test("closing a parent collapses its elder sibling, not its child", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "b1", intent: "outer" });
		seedScope(ctx, { id: "b2", intent: "inner" });
		await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "inner" })]),
		);
		const innerEnd = await runAssistant(
			host,
			ctx,
			assistant([call("e1", "scope", { end: true })]),
		);
		expect(innerEnd[0].output.content[0].text).toContain(
			"back inside the enclosing scope",
		);
		expect(innerEnd[0].output.content[0].text).not.toContain(
			"outside all scopes",
		);

		await runAssistant(
			host,
			ctx,
			assistant([call("e2", "scope", { end: true })]),
		);
		const joined = texts(await outbound(host, ctx)).join("\n");
		expect(joined).toContain("read:inner");
		expect(joined).not.toContain(finishedReport("inner done"));
	});

	test("collapses the elder sibling inside an enclosing scope", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "a1", intent: "parent" });
		seedScope(ctx, { id: "b1", intent: "elder" });
		await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "elder" })]),
		);
		await runAssistant(
			host,
			ctx,
			assistant([call("e1", "scope", { end: true })]),
		);
		seedScope(ctx, { id: "c1", intent: "younger" });
		await runAssistant(
			host,
			ctx,
			assistant([call("r2", "read", { path: "younger" })]),
		);
		const youngerEnd = await runAssistant(
			host,
			ctx,
			assistant([call("e2", "scope", { end: true })]),
		);
		expect(youngerEnd[0].output.content[0].text).not.toContain("was collapsed");
		const joined = texts(await outbound(host, ctx)).join("\n");
		expect(joined).toContain("read:elder");
		expect(joined).toContain("read:younger");
		expect(joined).not.toContain(finishedReport("younger done"));
	});

	test("same-tool calls in one assistant message share one budget unit", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "b1", intent: "batch" });
		const batch = await runAssistant(
			host,
			ctx,
			assistant([
				call("r1", "read", { path: "one" }),
				call("r2", "read", { path: "two" }),
			]),
		);
		expect(batch[0].blocked).toBe(false);
		expect(batch[1].blocked).toBe(false);

		const after = await runAssistant(
			host,
			ctx,
			assistant([call("r3", "read", { path: "three" })]),
		);
		expect(after[0].blocked).toBe(true);
		expect(after[0].result.content[0].text).toContain(
			'Tool "read" has no budget left',
		);
	});

	test("different tools in one assistant message share one budget unit", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "b1", intent: "split", budget: { read: 1, bash: 1 } });
		const batch = await runAssistant(
			host,
			ctx,
			assistant([
				call("r1", "read", { path: "one" }),
				call("r2", "read", { path: "two" }),
				call("x1", "bash", { command: "true" }),
			]),
		);
		expect(batch.map((entry) => entry.blocked)).toEqual([false, false, false]);
		const joined = texts(await outbound(host, ctx)).join("\n");
		expect(joined).toContain("read 0.33/1.00");
		expect(joined).toContain("bash 0.67/1.00");
	});

	function dropBeginEntry(manager, toolCallId) {
		const victim = manager.entries.find(
			(entry) =>
				entry.type === "message" &&
				entry.message?.role === "assistant" &&
				entry.message.content.some(
					(block) => block.type === "toolCall" && block.id === toolCallId,
				),
		);
		expect(victim).toBeDefined();
		for (const entry of manager.entries) {
			if (entry.parentId === victim.id) entry.parentId = victim.parentId;
		}
		manager.entries.splice(manager.entries.indexOf(victim), 1);
	}

	test("closes when the elder sibling's begin left the branch", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "b1", intent: "elder" });
		await runAssistant(host, ctx, assistant([call("r1", "read", { path: "elder" })]));
		await runAssistant(host, ctx, assistant([call("e1", "scope", { end: true })]));

		// Compaction keeps the collapse record but removes the begin message.
		dropBeginEntry(manager, "b1");

		seedScope(ctx, { id: "b2", intent: "younger" });
		const ended = await runAssistant(
			host,
			ctx,
			assistant([call("e2", "scope", { end: true })]),
		);
		expect(ended[0].output.isError).toBeFalsy();
		expect(ended[0].output.content[0].text).toContain("Scope closed.");
		expect(ended[0].output.content[0].text).not.toContain("SCOPE_BOUNDARY");
	});

	test("closes when its own begin left the branch", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "b1", intent: "work" });
		dropBeginEntry(manager, "b1");

		const ended = await runAssistant(
			host,
			ctx,
			assistant([call("e1", "scope", { end: true })]),
		);
		expect(ended[0].output.isError).toBeFalsy();
		expect(ended[0].output.content[0].text).toContain("outside all scopes");
	});
});

describe("amend", () => {
	test("undoes the previous beat, refunds budget, and filters outbound", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);

		seedScope(ctx, { id: "b1", intent: "read twice", budget: { read: 2 } });
		await runAssistant(
			host,
			ctx,
			assistant([
				call("r1", "read", { path: "one" }),
			]),
		);
		await runAssistant(host, ctx, assistant([call("r2", "read", { path: "two" })]));
		const third = await runAssistant(
			host,
			ctx,
			assistant([
				call("g1", "amend", { reflection: "the second read was redundant" }),
				call("r3", "read", { path: "three" }),
			]),
		);
		expect(third[0].output.content[0].text).toContain("Amended the previous beat away");
		expect(third[0].output.content[0].text).toContain("the second read was redundant");
		expect(third[0].output.content[0].text).toContain("Refunded 1 tool call");
		expect(third[1].blocked).toBe(false);

		const view = await outbound(host, ctx);
		const joined = texts(view).join("\n");
		expect(joined).not.toContain("read:two");
		expect(joined).toContain("read:three");
		expect(JSON.stringify(view)).toContain("the second read was redundant");
	});

	test("cannot amend across the scope begin", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "b1", intent: "work", budget: { read: 2 } });
		const result = await runAssistant(
			host,
			ctx,
			assistant([call("g1", "amend", { reflection: "nothing before this scope" })]),
		);
		expect(result[0].output.content[0].text).toContain("SCOPE_BOUNDARY");
	});
});

describe("pin", () => {
	function hasCall(message, id) {
		return (
			message?.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "toolCall" && block.id === id)
		);
	}

	test("is free, unlimited, and works outside scopes", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);

		const outside = await runAssistant(
			host,
			ctx,
			assistant([
				call("p1", "pin", { assumption: "A" }),
				call("p2", "pin", { finding: "F", conclusion: "C" }),
			]),
		);
		expect(outside[0].blocked).toBe(false);
		expect(outside[1].blocked).toBe(false);
		expect(outside[0].output.content[0].text).toBe("OK");
		expect(outside[1].output.content[0].text).toBe("OK");

		seedScope(ctx, { id: "b1", intent: "work" });
		const inside = await runAssistant(
			host,
			ctx,
			assistant([
				call("p3", "pin", { deduction: "D" }),
				call("p4", "pin", { induction: "I" }),
			]),
		);
		expect(inside[0].blocked).toBe(false);
		expect(inside[1].blocked).toBe(false);
		const read = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "still available" })]),
		);
		expect(read[0].blocked).toBe(false);
	});

	test("pin is retained in place with its interior when no fold is due", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);

		seedScope(ctx, { id: "b1", intent: "one" });
		await runAssistant(
			host,
			ctx,
			assistant([
				call("q1", "pin", {
					assumption: "durable note",
					deduction: "D",
					finding: "F",
					conclusion: "C",
				}),
				call("r1", "read", { path: "one" }),
			]),
		);
		await runAssistant(
			host,
			ctx,
			assistant([call("e1", "scope", { end: true })]),
		);
		seedScope(ctx, { id: "b2", intent: "two" });
		await runAssistant(host, ctx, assistant([call("r2", "read", { path: "two" })]));
		await runAssistant(
			host,
			ctx,
			assistant([call("e2", "scope", { end: true })]),
		);

		const branch = manager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		const pinIndex = branch.findIndex((message) => hasCall(message, "q1"));
		const firstEndIndex = branch.findIndex((message) => hasCall(message, "e1"));
		// No cost pressure: no fold runs, so the pin stays in its original beat.
		expect(pinIndex).toBeLessThan(firstEndIndex);
		expect(branch.some((message) => message.toolCallId === "q1")).toBe(true);
		expect(branch.some((message) => hasCall(message, "r1"))).toBe(true);
		expect(branch.some((message) => message.toolCallId === "r1")).toBe(true);
		expect(
			branch[pinIndex].content
				.filter((block) => block.type === "toolCall")
				.some((block) => block.id === "q1"),
		).toBe(true);
		expect(JSON.stringify(branch)).toContain("durable note");

		const view = await outbound(host, ctx);
		expect(view.some((message) => hasCall(message, "q1"))).toBe(true);
		expect(view.some((message) => message.toolCallId === "r1")).toBe(true);
		expect(JSON.stringify(view)).toContain("durable note");
	});
});

describe("nested scopes", () => {
	test("only the innermost budget is consumed", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "b1", intent: "outer", budget: { read: 0, bash: 1 } });
		seedScope(ctx, { id: "b2", intent: "inner", budget: { read: 1 } });
		await runAssistant(
			host,
			ctx,
			assistant([
				call("r1", "read", { path: "inner" }),
			]),
		);
		const afterRead = await runAssistant(host, ctx, assistant([call("r2", "read", { path: "inner2" })]));
		expect(afterRead[0].blocked).toBe(true);
		const innerEnd = await runAssistant(host, ctx, assistant([call("e1", "scope", { end: true })]));
		expect(innerEnd[0].output.content[0].text).toContain("Scope closed");
		const bash = await runAssistant(host, ctx, assistant([call("s1", "bash", { command: "true" })]));
		expect(bash[0].blocked).toBe(false);
		const outerEnd = await runAssistant(host, ctx, assistant([call("e2", "scope", { end: true })]));
		expect(outerEnd[0].output.content[0].text).toContain("Scope closed");
	});
});

describe("vibe mode", () => {
	test("keeps registered scope tools when entering vibe mode", async () => {
		class Session {
			constructor(registered) {
				this.registered = registered;
			}
			getAllToolNames() {
				return this.registered;
			}
			async activateVibeTools(names) {
				this.active = [...names, "task"];
			}
		}
		installVibeTools(Session);
		installVibeTools(Session);
		const session = new Session(["read", "scope", "amend", "pin"]);
		await session.activateVibeTools(["read", "scope"]);
		expect(session.active).toEqual(["read", "scope", "amend", "pin", "task"]);
		const other = new Session(["read"]);
		await other.activateVibeTools(["read"]);
		expect(other.active).toEqual(["read", "task"]);
	});

	test("rewrites the host custom message outbound only", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		appendRequestMessages(ctx, {
			role: "custom",
			customType: "vibe-mode-context",
			content: "drive two worker CLIs",
			display: false,
		});
		const view = await outbound(host, ctx);
		expect(texts(view).join("\n")).toContain("direct as many parallel slice/swarm workers as causality allows");
		expect(view.some((message) => message.content === "drive two worker CLIs")).toBe(false);
	});
});

describe("same-message scope and command co-dispatch", () => {
	async function runHostPrepareOrder(host, ctx, message) {
		const manager = ctx.sessionManager;
		const agent = ctx.session.agent;
		await outbound(host, ctx);
		const decisions = [];
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const tool = host.tools.get(block.name) ?? {
				name: block.name,
				execute: () => ({ content: [{ type: "text", text: `${block.name} ok` }] }),
			};
			const decision = await agent.beforeToolCall({
				assistantMessage: message, toolCall: block, tool, args: block.arguments,
			});
			decisions.push({ block, decision, tool });
		}
		const results = [];
		for (const { block, decision, tool } of decisions) {
			if (decision?.block) {
				const result = toolResult(block.id, block.name, decision.reason, true);
				results.push({ result, blocked: true });
				continue;
			}
			const output = await tool.execute(block.id, block.arguments, undefined, undefined, ctx);
			const result = toolResult(block.id, block.name, output.content[0].text, Boolean(output.isError));
			results.push({ result, blocked: false, output });
		}
		manager.appendMessage(message);
		appendRequestMessages(ctx, message);
		for (const { result } of results) {
			manager.appendMessage(result);
			appendRequestMessages(ctx, result);
		}
		await emit(host.handlers, "assistant_message", { type: "assistant_message", message }, ctx);
		return results;
	}

	test("functional command + scope(end) in one message runs the command before closing scope", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "s1", intent: "work" });
		const results = await runAssistant(host, ctx, assistant([
			call("r1", "read", { path: "a.mjs" }),
			call("s2", "scope", { end: true }),
		]));
		expect(results[0].blocked).toBe(false);
		expect(results[1].blocked).toBe(false);
		expect(results[1].output.content[0].text).toContain("Scope closed. You are outside all scopes.");
	});

	test("amend + functional command in one message refunds before tool_call budget check", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		seedScope(ctx, { id: "s1", intent: "retry" });
		const first = await runHostPrepareOrder(
			host,
			ctx,
			assistant([call("r1", "read", { path: "wrong.mjs" })]),
		);
		expect(first[0].blocked).toBe(false);

		const retried = await runHostPrepareOrder(
			host,
			ctx,
			assistant([
				call("g1", "amend", { reflection: "read wrong file" }),
				call("r2", "read", { path: "right.mjs" }),
			]),
		);
		expect(retried[0].blocked).toBe(false);
		expect(retried[0].output.content[0].text).toContain("Amended the previous beat away");
		expect(retried[0].output.content[0].text).toContain("read wrong file");
		expect(retried[1].blocked).toBe(false);
	});
});

describe("herd mode", () => {
	test("/herd flips the mode without messaging the model and pins the openable stage", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const command = host.commands.get("herd");
		expect(typeof command?.handler).toBe("function");
		expect(command.description).toContain("decision framing");

		const before = host.steers.length;
		await command.handler("", ctx);
		expect(host.steers.length).toBe(before);

		const rejected = await runAssistant(host, ctx, assistant([
			call("h1", "scope", { begin: { stage: "acceptance-cases", elder_report: null, fission: [{ intent: "wrong", budget: { read: 1 }, permission: "ro" }] } }),
		]));
		expect(rejected[0].output.isError).toBe(true);
		expect(rejected[0].output.content[0].text).toContain("INVALID_STAGE");

		const opened = seedScope(ctx, { id: "h2", intent: "frame the work", stage: "decision-framing" });
		expect(opened.stage).toBe("decision-framing");

		const asked = await runAssistant(host, ctx, assistant([
			call("a1", "ask", { question: "Which outcome matters most?" }),
		]));
		expect(asked[0].blocked).toBe(false);

		const beforeOff = host.steers.length;
		await command.handler("", ctx);
		expect(host.steers.length).toBe(beforeOff);

		const askedOff = await runAssistant(host, ctx, assistant([
			call("a2", "ask", { question: "Still allowed?" }),
		]));
		expect(askedOff[0].blocked).toBe(true);
		expect(askedOff[0].result.content[0].text).toContain("decision-framing");

		const framedAgain = await runAssistant(host, ctx, assistant([
			call("h3", "scope", { begin: { stage: "decision-framing", elder_report: null, fission: [{ intent: "frame again", budget: { read: 1 }, permission: "ro" }] } }),
		]));
		expect(framedAgain[0].output.isError).toBe(true);
		expect(framedAgain[0].output.content[0].text).toContain("INVALID_STAGE");
	});

	test("/herd with text toggles the mode and sends exactly one plain user message", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const command = host.commands.get("herd");
		const before = host.steers.length;

		await command.handler("  收束发布范围  ", ctx);

		expect(host.steers.length).toBe(before + 1);
		expect(host.steers.at(-1)).toEqual({
			text: "收束发布范围",
			options: undefined,
		});

		const framed = seedScope(ctx, { id: "t1", intent: "frame release", stage: "decision-framing" });
		expect(framed.stage).toBe("decision-framing");
	});

	test("a bare /herd reaches the model through the next context receipt", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const before = host.steers.length;

		await host.commands.get("herd").handler("", ctx);
		const pulled = await outbound(host, ctx);

		expect(host.steers.length).toBe(before);
		const receipt = pulled.at(-1);
		expect(receipt.herdSkill).toBe(true);
		expect(receipt.content[0].text).toContain("Herd mode: on.");
	});

	test("default mode blocks ask outside and inside a scope", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const outside = await runAssistant(host, ctx, assistant([
			call("a0", "ask", { question: "Anyone there?" }),
		]));
		expect(outside[0].blocked).toBe(true);
		expect(outside[0].result.content[0].text).toContain("/herd");

		const framing = await runAssistant(host, ctx, assistant([
			call("s0", "scope", { begin: { stage: "decision-framing", elder_report: null, fission: [{ intent: "framing", budget: { read: 1 }, permission: "ro" }] } }),
		]));
		expect(framing[0].output.isError).toBe(true);
		expect(framing[0].output.content[0].text).toContain("INVALID_STAGE");
		expect(framing[0].output.content[0].text).toContain("acceptance-cases");

		seedScope(ctx, { id: "s1", intent: "build" });
		const inside = await runAssistant(host, ctx, assistant([
			call("a1", "ask", { question: "Proceed?" }),
		]));
		expect(inside[0].blocked).toBe(true);
	});

	test("wait is free inside a scope and blocked outside", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const outside = await runAssistant(host, ctx, assistant([
			call("w0", "wait", {}),
		]));
		expect(outside[0].blocked).toBe(true);

		seedScope(ctx, { id: "s1", intent: "free wait", budget: { wait: 1 } });
		const waited = await runAssistant(host, ctx, assistant([
			call("w1", "wait", {}),
			call("w2", "wait", {}),
		]));
		expect(waited[0].blocked).toBe(false);
		expect(waited[1].blocked).toBe(false);

		const read = await runAssistant(host, ctx, assistant([
			call("r1", "read", { path: "a.mjs" }),
		]));
		expect(read[0].blocked).toBe(true);
		expect(read[0].result.content[0].text).toContain('Tool "read" has no budget left');
	});

	test("a begin without time is refused", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const refused = await runAssistant(host, ctx, assistant([
			{ type: "toolCall", id: "nt1", name: "scope", arguments: { begin: { stage: "direct-execution", elder_report: null, fission: [{ intent: "no time", budget: {}, permission: "ro" }] } } },
		]));
		expect(JSON.stringify(refused)).toContain("INVALID_TIME");
	});

	test("a scope records a wall-clock deadline in its receipt", async () => {
		const manager = makeManager();
		const { ctx } = await start(manager);
		const opened = beginScope(stateFor(ctx).state, {
			toolCallId: "t1",
			intent: "timed",
			stage: "direct-execution",
			budget: { read: 1 },
			time: 5,
		});
		expect(opened.ok).toBe(true);
		expect(beginText(opened.scope)).toContain("time 0:05/0:05");
	});

	test("kills a tool that overruns deadline+1s and replaces its result", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const session = ctx.session;
		session.agent.beforeToolCall = async () => undefined;
		let sawSignal = null;
		const slowExecute = (id, params, signal) => {
			sawSignal = signal;
			return new Promise((resolve) =>
				setTimeout(
					() => resolve({ content: [{ type: "text", text: "slow finished" }] }),
					1300,
				),
			);
		};
		host.tools.set("slow", { name: "slow", execute: slowExecute });
		const begin = {
			stage: "direct-execution",
			elder_report: null,
			time: 0.1,
			fission: [{ intent: "timed", budget: { slow: 1 }, permission: "ro" }],
		};
		const message = assistant([call("b2", "scope", { begin }), call("s1", "slow", {})]);
		await emit(host.handlers, "assistant_message", { type: "assistant_message", message }, ctx);
		seedScope(ctx, { id: "b2", intent: "timed", budget: { slow: 1 }, time: 0.1 });
		const tool = host.tools.get("slow");
		await session.agent.beforeToolCall(
			{ assistantMessage: message, toolCall: { id: "s1", name: "slow" }, tool },
			undefined,
		);
		const outcome = await tool
			.execute("s1", {}, undefined, undefined, ctx)
			.catch((error) => error);
		expect(sawSignal?.aborted).toBe(true);
		expect(outcome).toBeInstanceOf(Error);
		expect(String(outcome?.message ?? outcome)).toContain("OVERTIME");
	});

	test("the per-turn skill receipt carries the UTC clock", () => {
		const state = createState();
		state.startedAt = Date.now() - 90_000;
		const text = skillReceiptText(state, false);
		expect(text).toMatch(/UTC now \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
		expect(text).toContain("since this session began");
		expect(text).toMatch(/1m3\ds/);
		expect(text).toContain("强制以简体中文");
	});

	test("herd mode allows a text-only turn to stop naturally", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const simpleStop = await emit(host.handlers, "session_stop", { type: "session_stop" }, ctx);
		expect(simpleStop).toBeUndefined();

		await host.commands.get("herd").handler("", ctx);
		const before = host.steers.length;
		await emit(
			host.handlers,
			"assistant_message",
			{ type: "assistant_message", message: assistant([{ type: "text", text: "Waiting for your answer." }]) },
			ctx,
		);
		expect(host.steers.length).toBe(before);

		const allowed = await emit(host.handlers, "session_stop", { type: "session_stop" }, ctx);
		expect(allowed).toBeUndefined();
	});
});
