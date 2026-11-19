/**
 * Fake-host integration: exercises the real hooks and tool executes against a
 * session manager with the same tree semantics as omp.
 */

import { describe, expect, test } from "bun:test";
import { activate } from "../src/main.mjs";
import { installVibeTools, rememberSession } from "../src/host/index.mjs";
import { finishedReport } from "../src/transcript/index.mjs";

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
	return { type: "toolCall", id, name, arguments: args };
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

function makeRuntime(manager) {
	const host = makeHost();
	const ctx = { sessionManager: manager, agentMessages: [] };
	return { host, ctx };
}

async function start(manager) {
	const host = makeHost();
	await activate(host.pi);
	const ctx = { sessionManager: manager, agentMessages: [] };
	const user = { role: "user", content: "do the task", timestamp: Date.now() };
	manager.appendMessage(user);
	ctx.agentMessages.push(user);
	return { host, ctx };
}

async function runAssistant(host, ctx, message) {
	const manager = ctx.sessionManager;
	await emit(host.handlers, "assistant_message", { type: "assistant_message", message }, ctx);
	manager.appendMessage(message);
	ctx.agentMessages.push(message);
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
			ctx.agentMessages.push(result);
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
		ctx.agentMessages.push(result);
		results.push({ result, blocked: false, output });
	}
	return results;
}

async function outbound(host, ctx) {
	const result = await emit(host.handlers, "context", { type: "context", messages: ctx.agentMessages }, ctx);
	return result.messages;
}

function texts(messages) {
	return messages.map((message) =>
		typeof message.content === "string"
			? message.content
			: (message.content ?? []).map((block) => block.text ?? block.thinking ?? "").join(""),
	);
}

describe("scope lifecycle", () => {
	test("transitions between scopes and retains elder work as a hot workbench", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		await runAssistant(host, ctx, assistant([call("b1", "scope", {
			begin: { intent: "first", stage: "acceptance-cases", budget: { read: 1 }, elder_report: null },
		})]));
		await runAssistant(host, ctx, assistant([call("r1", "read", { path: "first" })]));
		const transition = await runAssistant(host, ctx, assistant([call("t1", "scope", {
			end: true, begin: { intent: "second", stage: "architecture-design", budget: { read: 1 }, elder_report: "first done" },
		})]));
		expect(transition[0].output.content[0].text).toContain("Scope closed.");
		expect(transition[0].output.content[0].text).toContain("You are now inside this scope.");
		expect(transition[0].output.content[0].text).not.toContain(
			"Scope closed. You are outside all scopes.",
		);
		const read = await runAssistant(host, ctx, assistant([call("r2", "read", { path: "second" })]));
		expect(read[0].blocked).toBe(false);
		await runAssistant(host, ctx, assistant([call("t2", "scope", {
			end: true, begin: { intent: "third", stage: "orchestration-plan", budget: { read: 1 }, elder_report: "second done" },
		})]));
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
			end: true, begin: { intent: "first", stage: "direct-execution", budget: { read: 1 }, elder_report: null },
		})]));
		expect(outside[0].output.content[0].text).toContain("NOT_IN_SCOPE");
		await runAssistant(host, ctx, assistant([call("b1", "scope", {
			begin: { intent: "first", stage: "direct-execution", budget: { read: 1 }, elder_report: null },
		})]));
		const invalid = await runAssistant(host, ctx, assistant([call("t1", "scope", {
			end: true, begin: { intent: "", stage: "direct-execution", budget: { read: 1 }, elder_report: "first done" },
		})]));
		expect(invalid[0].output.isError).toBe(true);
		const read = await runAssistant(host, ctx, assistant([call("r1", "read", { path: "still first" })]));
		expect(read[0].blocked).toBe(false);
	});

	test("begin, budget block, deferred collapse, outside tail", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);

		const first = await runAssistant(
			host,
			ctx,
			assistant([
				call("c1", "scope", { begin: { intent: "inspect config", stage: "direct-execution", budget: { read: 1 }, elder_report: null } }),
				call("c2", "read", { path: "config-one" }),
			]),
		);
		expect(first[0].output.content[0].text).toContain("You are now inside this scope.");
		expect(first[1].blocked).toBe(false);

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
		expect(third[0].output.content[0].text).toContain("younger sibling scope");

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
		await runAssistant(
			host,
			ctx,
			assistant([call("d1", "scope", { begin: { intent: "second pass", stage: "direct-execution", budget: { read: 1 }, elder_report: "done: config inspected" } })]),
		);
		await runAssistant(host, ctx, assistant([call("d2", "read", { path: "config-three" })]));
		const finalEnd = await runAssistant(
			host,
			ctx,
			assistant([call("d3", "scope", { end: true })]),
		);
		expect(finalEnd[0].output.content[0].text).toContain(
			"No elder sibling scope was collapsed.",
		);

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
		expect(joined).toContain("Before stopping, call todo to evaluate the ledger");
	});

	test("collapses one scope behind across three scopes", async () => {
		// Retained as a lifecycle regression: with no measured usage or pricing
		// the economics never cross the fold threshold, so all elders stay hot.
		const manager = makeManager();
		const { host, ctx } = await start(manager);

		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", { begin: { intent: "one", stage: "direct-execution", budget: { read: 1 }, elder_report: null } })]),
		);
		await runAssistant(host, ctx, assistant([call("r1", "read", { path: "one" })]));
		await runAssistant(host, ctx, assistant([call("e1", "scope", { end: true })]));
		await runAssistant(
			host,
			ctx,
			assistant([call("b2", "scope", { begin: { intent: "two", stage: "direct-execution", budget: { read: 1 }, elder_report: "scope one done" } })]),
		);
		await runAssistant(host, ctx, assistant([call("r2", "read", { path: "two" })]));
		await runAssistant(host, ctx, assistant([call("e2", "scope", { end: true })]));

		let joined = texts(await outbound(host, ctx)).join("\n");
		expect(joined).toContain("read:one");
		expect(joined).toContain("read:two");
		expect(joined).not.toContain(finishedReport("scope one done"));
		expect(joined).not.toContain(finishedReport("scope two done"));

		await runAssistant(
			host,
			ctx,
			assistant([call("b3", "scope", { begin: { intent: "three", stage: "direct-execution", budget: { read: 1 }, elder_report: "scope two done" } })]),
		);
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
		expect(result[0].result.content[0].text).toContain("Not in a scope");
		const view = await outbound(host, ctx);
		expect(texts(view).join("\n")).toContain("You are outside all scopes.");
	});

	test("nudges a natural stop inside a scope", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", {
				begin: { intent: "work", stage: "direct-execution", budget: { read: 1 }, elder_report: null },
			})]),
		);
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

	test("nudges a final answer outside all scopes before any todo evaluation", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		await runAssistant(
			host,
			ctx,
			assistant([{ type: "text", text: "Final answer." }]),
		);
		expect(host.steers.length).toBe(1);
		expect(host.steers[0].text).toContain("evaluate the ledger with todo");
		expect(host.steers[0].text).toContain(
			"A natural stop is allowed only in one sequence",
		);
	});

	test("closing a parent collapses its elder sibling, not its child", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", {
				begin: { intent: "outer", stage: "direct-execution", budget: { read: 1 }, elder_report: null },
			})]),
		);
		await runAssistant(
			host,
			ctx,
			assistant([call("b2", "scope", {
				begin: { intent: "inner", stage: "direct-execution", budget: { read: 1 }, elder_report: null },
			})]),
		);
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
		await runAssistant(
			host,
			ctx,
			assistant([call("a1", "scope", {
				begin: { intent: "parent", stage: "direct-execution", budget: { read: 1 }, elder_report: null },
			})]),
		);
		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", {
				begin: { intent: "elder", stage: "direct-execution", budget: { read: 1 }, elder_report: null },
			})]),
		);
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
		await runAssistant(
			host,
			ctx,
			assistant([call("c1", "scope", {
				begin: { intent: "younger", stage: "direct-execution", budget: { read: 1 }, elder_report: "elder done" },
			})]),
		);
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
		expect(youngerEnd[0].output.content[0].text).toContain(
			"No elder sibling scope was collapsed.",
		);
		const joined = texts(await outbound(host, ctx)).join("\n");
		expect(joined).toContain("read:elder");
		expect(joined).toContain("read:younger");
		expect(joined).not.toContain(finishedReport("younger done"));
	});

	test("same-tool calls in one assistant message share one budget unit", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", {
				begin: { intent: "batch", stage: "direct-execution", budget: { read: 1 } },
			})]),
		);
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
		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", {
				begin: { intent: "split", stage: "direct-execution", budget: { read: 1, bash: 1 } },
			})]),
		);
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
		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", {
				begin: { intent: "elder", stage: "direct-execution", budget: { read: 1 }, elder_report: null },
			})]),
		);
		await runAssistant(host, ctx, assistant([call("r1", "read", { path: "elder" })]));
		await runAssistant(host, ctx, assistant([call("e1", "scope", { end: true })]));

		// Compaction keeps the collapse record but removes the begin message.
		dropBeginEntry(manager, "b1");

		await runAssistant(
			host,
			ctx,
			assistant([call("b2", "scope", {
				begin: { intent: "younger", stage: "direct-execution", budget: { read: 1 }, elder_report: "elder done" },
			})]),
		);
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
		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", {
				begin: { intent: "work", stage: "direct-execution", budget: { read: 1 }, elder_report: null },
			})]),
		);
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

describe("regret", () => {
	test("undoes the previous beat, refunds budget, and filters outbound", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);

		await runAssistant(
			host,
			ctx,
			assistant([
				call("b1", "scope", { begin: { intent: "read twice", stage: "direct-execution", budget: { read: 2 }, elder_report: null } }),
				call("r1", "read", { path: "one" }),
			]),
		);
		await runAssistant(host, ctx, assistant([call("r2", "read", { path: "two" })]));
		const third = await runAssistant(
			host,
			ctx,
			assistant([
				call("g1", "regret", { reflection: "the second read was redundant" }),
				call("r3", "read", { path: "three" }),
			]),
		);
		expect(third[0].output.content[0].text).toContain("Undid the previous beat");
		expect(third[0].output.content[0].text).toContain("Refunded 1 tool call");
		expect(third[1].blocked).toBe(false);

		const view = await outbound(host, ctx);
		const joined = texts(view).join("\n");
		expect(joined).not.toContain("read:two");
		expect(joined).toContain("read:three");
		expect(JSON.stringify(view)).toContain("the second read was redundant");
	});

	test("cannot regret across the scope begin", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", { begin: { intent: "work", stage: "direct-execution", budget: { read: 2 }, elder_report: null } })]),
		);
		const result = await runAssistant(
			host,
			ctx,
			assistant([call("g1", "regret", { reflection: "nothing before this scope" })]),
		);
		expect(result[0].output.content[0].text).toContain("SCOPE_BOUNDARY");
	});
});

describe("defer", () => {
	test("delivers deferred findings as a steering prompt and keeps residual defers", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		await runAssistant(
			host,
			ctx,
			assistant([
				call("b1", "scope", { begin: { intent: "limited work", stage: "direct-execution", budget: { read: 1 }, elder_report: null } }),
				call("d1", "defer", { intent: "fix the docs later" }),
			]),
		);
		await runAssistant(
			host,
			ctx,
			assistant([call("g1", "regret", { reflection: "the defer beat was premature" })]),
		);
		const end = await runAssistant(
			host,
			ctx,
			assistant([call("e1", "scope", { end: true })]),
		);
		expect(end[0].blocked).toBe(false);
		expect(host.steers.length).toBe(1);
		expect(host.steers[0].text).toContain("fix the docs later");
		expect(host.steers[0].options).toEqual({ deliverAs: "steer" });
		expect(end[0].output.content[0].text).toContain("fix the docs later");
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

		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", { begin: { intent: "work", stage: "direct-execution", budget: { read: 1 } } })]),
		);
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

		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", { begin: { intent: "one", stage: "direct-execution", budget: { read: 1 }, elder_report: null } })]),
		);
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
		await runAssistant(
			host,
			ctx,
			assistant([call("b2", "scope", { begin: { intent: "two", stage: "direct-execution", budget: { read: 1 }, elder_report: "one done" } })]),
		);
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
		await runAssistant(
			host,
			ctx,
			assistant([
				call("b1", "scope", { begin: { intent: "outer", stage: "direct-execution", budget: { read: 0, bash: 1 }, elder_report: null } }),
				call("b2", "scope", { begin: { intent: "inner", stage: "direct-execution", budget: { read: 1 }, elder_report: null } }),
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
		const session = new Session(["read", "scope", "regret", "defer", "pin"]);
		await session.activateVibeTools(["read", "scope"]);
		expect(session.active).toEqual(["read", "scope", "regret", "defer", "pin", "task"]);
		const other = new Session(["read"]);
		await other.activateVibeTools(["read"]);
		expect(other.active).toEqual(["read", "task"]);
	});

	test("rewrites the host custom message outbound only", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		ctx.agentMessages.push({
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
		const agent = {
			beforeToolCall({ toolCall, args }) {
				return emit(host.handlers, "tool_call", {
					type: "tool_call", toolCallId: toolCall.id,
					toolName: toolCall.name, input: args,
				}, ctx);
			},
		};
		rememberSession({ sessionManager: manager, agent });
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
		ctx.agentMessages.push(message);
		for (const { result } of results) {
			manager.appendMessage(result);
			ctx.agentMessages.push(result);
		}
		await emit(host.handlers, "assistant_message", { type: "assistant_message", message }, ctx);
		return results;
	}

	test("scope(begin) + functional command in one message works when tool_call precedes persistence", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const results = await runHostPrepareOrder(
			host,
			ctx,
			assistant([
				call("s1", "scope", { begin: { intent: "inspect", stage: "direct-execution", budget: { read: 1 }, elder_report: null } }),
				call("r1", "read", { path: "a.mjs" }),
			]),
		);
		expect(results[0].blocked).toBe(false);
		expect(results[0].output.content[0].text).toContain("You are now inside this scope.");
		expect(results[1].blocked).toBe(false);
		expect(results[1].result.content[0].text).toBe("read ok");

		// Budget should be exhausted after that 1 read, and no duplicate scope should be open.
		const secondRead = await runHostPrepareOrder(
			host,
			ctx,
			assistant([call("r2", "read", { path: "b.mjs" })]),
		);
		expect(secondRead[0].blocked).toBe(true);
		expect(secondRead[0].result.content[0].text).toContain("no budget left");

		const closed = await runHostPrepareOrder(
			host,
			ctx,
			assistant([call("s2", "scope", { end: true })]),
		);
		expect(closed[0].blocked).toBe(false);
		expect(closed[0].output.content[0].text).toContain("Scope closed. You are outside all scopes.");
	});

	test("functional command + scope(end) in one message runs the command before closing scope", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		await runAssistant(host, ctx, assistant([
			call("s1", "scope", { begin: { intent: "work", stage: "direct-execution", budget: { read: 1 }, elder_report: null } }),
		]));
		const results = await runAssistant(host, ctx, assistant([
			call("r1", "read", { path: "a.mjs" }),
			call("s2", "scope", { end: true }),
		]));
		expect(results[0].blocked).toBe(false);
		expect(results[1].blocked).toBe(false);
		expect(results[1].output.content[0].text).toContain("Scope closed. You are outside all scopes.");
	});

	test("regret + functional command in one message refunds before tool_call budget check", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		await runHostPrepareOrder(
			host,
			ctx,
			assistant([call("s1", "scope", { begin: { intent: "retry", stage: "direct-execution", budget: { read: 1 }, elder_report: null } })]),
		);
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
				call("g1", "regret", { reflection: "read wrong file" }),
				call("r2", "read", { path: "right.mjs" }),
			]),
		);
		expect(retried[0].blocked).toBe(false);
		expect(retried[0].output.content[0].text).toContain("Undid the previous beat.");
		expect(retried[1].blocked).toBe(false);
	});
});

describe("herd mode", () => {
	test("/herd toggles the mode, steers, and pins the openable stage", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const command = host.commands.get("herd");
		expect(typeof command?.handler).toBe("function");
		expect(command.description).toContain("decision framing");

		await command.handler("", ctx);
		expect(host.steers.at(-1).text).toContain("Herd mode is on.");
		expect(host.steers.at(-1).options).toEqual({ deliverAs: "steer" });

		const rejected = await runAssistant(host, ctx, assistant([
			call("h1", "scope", { begin: { intent: "wrong", stage: "acceptance-cases", budget: { read: 1 }, elder_report: null } }),
		]));
		expect(rejected[0].output.isError).toBe(true);
		expect(rejected[0].output.content[0].text).toContain("INVALID_STAGE");

		const opened = await runAssistant(host, ctx, assistant([
			call("h2", "scope", { begin: { intent: "frame the work", stage: "decision-framing", budget: { read: 1 }, elder_report: null } }),
		]));
		expect(opened[0].output.isError).not.toBe(true);
		expect(opened[0].output.content[0].text).toContain("Stage: decision-framing");

		const asked = await runAssistant(host, ctx, assistant([
			call("a1", "ask", { question: "Which outcome matters most?" }),
		]));
		expect(asked[0].blocked).toBe(false);

		await command.handler("", ctx);
		expect(host.steers.at(-1).text).toContain("Herd mode is off.");

		const askedOff = await runAssistant(host, ctx, assistant([
			call("a2", "ask", { question: "Still allowed?" }),
		]));
		expect(askedOff[0].blocked).toBe(true);
		expect(askedOff[0].result.content[0].text).toContain("decision-framing");

		const framedAgain = await runAssistant(host, ctx, assistant([
			call("h3", "scope", { begin: { intent: "frame again", stage: "decision-framing", budget: { read: 1 }, elder_report: null } }),
		]));
		expect(framedAgain[0].output.isError).toBe(true);
		expect(framedAgain[0].output.content[0].text).toContain("INVALID_STAGE");
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
			call("s0", "scope", { begin: { intent: "framing", stage: "decision-framing", budget: { read: 1 }, elder_report: null } }),
		]));
		expect(framing[0].output.isError).toBe(true);
		expect(framing[0].output.content[0].text).toContain("INVALID_STAGE");
		expect(framing[0].output.content[0].text).toContain("acceptance-cases");

		await runAssistant(host, ctx, assistant([
			call("s1", "scope", { begin: { intent: "build", stage: "direct-execution", budget: { read: 1 }, elder_report: null } }),
		]));
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

		await runAssistant(host, ctx, assistant([
			call("s1", "scope", { begin: { intent: "free wait", stage: "direct-execution", budget: { wait: 1 }, elder_report: null } }),
		]));
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

	test("herd mode allows a text-only turn to stop naturally", async () => {
		const manager = makeManager();
		const { host, ctx } = await start(manager);
		const nudged = await emit(host.handlers, "session_stop", { type: "session_stop" }, ctx);
		expect(nudged).not.toBeUndefined();

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
