/**
 * Relay integration: real hooks, real todo wrapper, fake native todo, and a
 * fake AgentSession.handoff(). The host's model gate runs before the context
 * hook and turns the next request into the successor's first request.
 */

import { describe, expect, test } from "bun:test";
import { countHandoffCompactions } from "../src/handoff/index.mjs";
import { activate } from "../src/main.mjs";
import {
	installInteractiveCapture,
	installVibeTools,
	rememberSession,
	rememberTui,
	sessionFor,
	tuiFor,
} from "../src/host/index.mjs";
import { stateFor } from "../src/station/index.mjs";

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
			let current = fromId
				? entries.find((entry) => entry.id === fromId)
				: entries.find((entry) => entry.id === leafId);
			while (current) {
				path.unshift(current);
				current = current.parentId
					? entries.find((entry) => entry.id === current.parentId)
					: undefined;
			}
			return path;
		},
		branch: (entryId) => {
			if (!entries.some((entry) => entry.id === entryId)) {
				throw new Error(`missing ${entryId}`);
			}
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
		appendCompaction: (method, details) => {
			const entry = {
				type: "compaction",
				method,
				details,
				id: id(),
				parentId: leafId,
			};
			entries.push(entry);
			leafId = entry.id;
			return entry.id;
		},
		appendSessionInit: (fields) => {
			const entry = {
				type: "session_init",
				...fields,
				id: id(),
				parentId: leafId,
			};
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
	const steers = [];
	const messages = [];
	const activeTools = ["read", "write", "bash", "edit", "glob"];
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		sendUserMessage(text, options) {
			const entry = { text, options };
			messages.push(entry);
			if (options?.deliverAs === "steer") steers.push(entry);
			return Promise.resolve();
		},
		getActiveTools() {
			return [...activeTools];
		},
		async setActiveTools(names) {
			activeTools.splice(0, activeTools.length, ...names);
		},
	};
	return { pi, handlers, tools, steers, messages, activeTools };
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

function toolResult(id, name, text, isError, details) {
	const message = {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
	if (details !== undefined) message.details = details;
	return message;
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeNativeTodo() {
	let phases = [];
	const find = (content) => {
		for (const phase of phases) {
			const task = phase.tasks.find((item) => item.content === content);
			if (task) return task;
		}
		return null;
	};
	return {
		get phases() {
			return phases;
		},
		execute(params) {
			const op = params.op ?? (Array.isArray(params.list) ? "init" : "view");
			if (op === "init") {
				phases = (params.list ?? []).map((entry) => ({
					name: String(entry.phase ?? "Phase"),
					tasks: (entry.items ?? []).map((content) => ({
						content: String(content),
						status: "pending",
					})),
				}));
			} else if (op === "done") {
				const task = find(params.task);
				if (task) task.status = "completed";
			} else if (op === "start") {
				const task = find(params.task);
				if (task) task.status = "in_progress";
			} else if (op === "block") {
				const task = find(params.task);
				if (task) {
					task.status = "blocked";
					if (params.reason) task.blocker = params.reason;
				}
			} else if (op === "drop") {
				const task = find(params.task);
				if (task) task.status = "abandoned";
			}
			return {
				content: [{ type: "text", text: `todo ${op}` }],
				details: {
					op,
					phases: clone(phases),
					storage: "memory",
				},
			};
		},
	};
}

async function start(options = {}) {
	const manager = makeManager();
	const host = makeHost();
	const native = makeNativeTodo();
	host.tools.set("todo", {
		name: "todo",
		execute: async () => ({ content: [{ type: "text", text: "host builtin" }] }),
	});
	const session = {
		sessionManager: manager,
		isGeneratingHandoff: false,
		calls: [],
		agent: {
			state: { messages: [] },
			beforeToolCall({ toolCall, args }) {
				return emit(host.handlers, "tool_call", {
					type: "tool_call", toolCallId: toolCall.id,
					toolName: toolCall.name, input: args,
				}, ctx);
			},
		},
		settings: {
			values: new Map([["compaction.keepRecentTokens", 20000]]),
			sets: [],
			get(key) {
				return this.values.get(key);
			},
			set(key, value) {
				this.sets.push([key, value]);
				this.values.set(key, value);
			},
		},
		async handoff(focus) {
			session.calls.push(focus);
			if (typeof options.handoff === "function") {
				return await options.handoff({ focus, session, call: session.calls.length });
			}
			return { ok: true };
		},
	};
	rememberSession(session);
	await activate(host.pi);
	const aborts = [];
	const ctx = {
		sessionManager: manager,
		agentMessages: [],
		mode: options.mode ?? "rpc",
		abort: () => {
			aborts.push(true);
		},
		invokeTool: (params) => native.execute(params),
	};
	if (options.sessionInit) manager.appendSessionInit(options.sessionInit);
	const user = { role: "user", content: "do the task", timestamp: Date.now() };
	manager.appendMessage(user);
	ctx.agentMessages.push(user);
	return { host, ctx, manager, native, session, aborts };
}

async function runAssistant(host, ctx, message, { prepareAll = false } = {}) {
	await emit(
		host.handlers,
		"assistant_message",
		{ type: "assistant_message", message },
		ctx,
	);
	ctx.sessionManager.appendMessage(message);
	ctx.agentMessages.push(message);
	const calls = message.content.filter((block) => block.type === "toolCall");
	const runtime = sessionFor(ctx)?.agent;
	const tools = new Map(calls.map((block) => [block.name, host.tools.get(block.name) ?? {
		name: block.name,
		execute: () => ({ content: [{ type: "text", text: `${block.name} ok` }] }),
	}]));
	const prepare = (block) => runtime?.beforeToolCall?.({
		assistantMessage: message, toolCall: block, args: block.arguments,
		tool: tools.get(block.name),
	}) ?? emit(host.handlers, "tool_call", {
		type: "tool_call", toolCallId: block.id,
		toolName: block.name, input: block.arguments,
	}, ctx);
	const decisions = new Map();
	if (prepareAll) {
		for (const block of calls) decisions.set(block.id, await prepare(block));
	}
	const results = [];
	for (const block of calls) {
		const decision = prepareAll ? decisions.get(block.id) : await prepare(block);
		if (decision?.block) {
			const result = toolResult(block.id, block.name, decision.reason, true);
			ctx.sessionManager.appendMessage(result);
			ctx.agentMessages.push(result);
			results.push({ result, blocked: true });
			continue;
		}
		let output;
		try {
			output = await tools.get(block.name).execute(
				block.id, block.arguments, undefined, undefined, ctx,
			);
		} catch (error) {
			output = { content: [{ type: "text", text: error.message }], isError: true };
		}
		const text = (output.content ?? [])
			.map((part) => part.text ?? "")
			.join("");
		const result = toolResult(
			block.id,
			block.name,
			text,
			Boolean(output.isError),
			output.details,
		);
		ctx.sessionManager.appendMessage(result);
		ctx.agentMessages.push(result);
		results.push({ result, blocked: false, output });
	}
	return results;
}

async function emitStop(host, ctx) {
	const result = await emit(
		host.handlers,
		"session_stop",
		{ type: "session_stop" },
		ctx,
	);
	await sleep(10);
	return result;
}

describe("relay integration", () => {
	test("a host that filters todo out keeps a read-write subagent relay-off", async () => {
		const { host, ctx } = await start({
			sessionInit: {
				agent: "task",
				readOnly: false,
				tools: ["read", "write", "bash"],
			},
		});
		host.activeTools.splice(0, host.activeTools.length, "read", "write");
		host.pi.setActiveTools = async (names) => {
			host.activeTools.splice(
				0,
				host.activeTools.length,
				...names.filter((name) => name !== "todo"),
			);
		};
		const context = await emit(host.handlers, "context", { messages: [] }, ctx);
		await sleep(5);
		const text = JSON.stringify(context.messages);
		expect(text).not.toContain("evaluate the ledger");
		await runAssistant(host, ctx, assistant([{ type: "text", text: "greeting" }]));
		expect(host.steers.length).toBe(0);
		expect(await emitStop(host, ctx)).toBeUndefined();
	});

	test("a read-write subagent that really holds todo keeps the relay", async () => {
		const { host, ctx } = await start({
			sessionInit: {
				agent: "task",
				readOnly: false,
				tools: ["read", "write", "bash"],
			},
		});
		host.activeTools.splice(0, host.activeTools.length, "read", "write", "todo");
		const context = await emit(host.handlers, "context", { messages: [] }, ctx);
		expect(JSON.stringify(context.messages)).toContain("evaluate the ledger");
		await runAssistant(host, ctx, assistant([{ type: "text", text: "greeting" }]));
		expect(host.steers.length).toBe(1);
	});

	test("a read-only subagent works without a scope and stops without relay", async () => {
		const { host, ctx } = await start({
			sessionInit: {
				agent: "scout",
				readOnly: true,
				tools: ["read", "grep", "glob"],
			},
		});
		const read = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "a" })]),
		);
		expect(read[0].blocked).toBe(false);
		const stop = await emitStop(host, ctx);
		expect(stop).toBeUndefined();
		const before = stateFor(ctx).state.epoch;
		await emit(
			host.handlers,
			"session_compact",
			{ type: "session_compact" },
			ctx,
		);
		expect(stateFor(ctx).state.epoch).toBe(before);
		const context = await emit(host.handlers, "context", { messages: [] }, ctx);
		const text = JSON.stringify(context.messages);
		expect(text).not.toContain("todo");
		expect(text).not.toContain("handoff");
	});

	test("a subagent classified before its session_init lands is reclassified", async () => {
		const { host, ctx } = await start();
		// The first hook can run before the host persists the subagent contract.
		// That early "main" verdict must not be cached for the whole session.
		await emit(host.handlers, "before_agent_start", { systemPrompt: [] }, ctx);
		ctx.sessionManager.appendSessionInit({
			agent: "scout",
			readOnly: true,
			tools: ["read", "grep", "glob"],
		});
		const read = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "a" })]),
		);
		expect(read[0].blocked).toBe(false);
		const context = await emit(host.handlers, "context", { messages: [] }, ctx);
		const text = JSON.stringify(context.messages);
		expect(text).not.toContain("todo");
		expect(text).not.toContain("handoff");
	});

	test("a read-write subagent keeps scope gating and gets todo activated", async () => {
		const { host, ctx } = await start({
			sessionInit: {
				agent: "task",
				readOnly: false,
				tools: ["read", "write", "bash", "edit"],
			},
		});
		await emit(host.handlers, "before_agent_start", { systemPrompt: [] }, ctx);
		expect(host.activeTools).toContain("todo");
		const read = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "a" })]),
		);
		expect(read[0].blocked).toBe(true);
		expect(read[0].result.content[0].text).toContain("Not in a scope");
		const context = await emit(host.handlers, "context", { messages: [] }, ctx);
		expect(JSON.stringify(context.messages)).toContain("todo");
	});

	test("a read-write subagent whose tools omit editor transports keeps the relay", async () => {
		const { host, ctx } = await start({
			sessionInit: {
				agent: "bash-writer",
				readOnly: false,
				tools: ["read", "grep", "bash"],
			},
		});
		await emit(host.handlers, "before_agent_start", { systemPrompt: [] }, ctx);
		expect(host.activeTools).toContain("todo");
		const read = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "a" })]),
		);
		expect(read[0].blocked).toBe(true);
		expect(read[0].result.content[0].text).toContain("Not in a scope");
	});

	test("plugin-owned tools never start the relay for a read-only subagent", async () => {
		const { host, ctx } = await start({
			sessionInit: {
				agent: "scout",
				readOnly: true,
				tools: ["read", "grep", "glob", "scope", "pin", "defer", "regret"],
			},
		});
		host.activeTools.splice(0, host.activeTools.length, "read", "grep");
		const context = await emit(host.handlers, "context", { messages: [] }, ctx);
		expect(JSON.stringify(context.messages)).not.toContain("handoff");
		expect(host.activeTools).not.toContain("todo");
		const read = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "a" })]),
		);
		expect(read[0].blocked).toBe(false);
	});

	test("the relay verdict grants todo even before before_agent_start", async () => {
		const { host, ctx } = await start({
			sessionInit: {
				agent: "task",
				readOnly: false,
				tools: ["read", "write", "bash", "edit"],
			},
		});
		host.activeTools.splice(0, host.activeTools.length, "read");
		await emit(host.handlers, "context", { messages: [] }, ctx);
		await sleep(5);
		expect(host.activeTools).toContain("todo");
	});

	test("todo is blocked inside a scope and free outside; other tools stay gated", async () => {
		const { host, ctx } = await start();
		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", { begin: { intent: "work", budget: { read: 1 }, elder_report: null } })]),
		);
		const blocked = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "view" })]),
		);
		expect(blocked[0].blocked).toBe(true);
		expect(blocked[0].result.content[0].text).toContain("TODO_OUTSIDE_SCOPE_ONLY");

		const ended = await runAssistant(
			host,
			ctx,
			assistant([call("e1", "scope", { end: true })]),
		);
		expect(ended[0].output.content[0].text).toContain("Call todo now");

		const outsideTodo = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(outsideTodo[0].blocked).toBe(false);
		expect(outsideTodo[0].output.content.at(-1).text).toContain("RELAY STATE");

		const outsideRead = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "a" })]),
		);
		expect(outsideRead[0].blocked).toBe(true);
		expect(outsideRead[0].result.content[0].text).toContain("Not in a scope");
		expect(outsideRead[0].result.content[0].text).toContain("only todo");
	});

	test("scope barriers preserve todo order when the host prepares the entire batch first", async () => {
		const { host, ctx } = await start();
		const open = call("b1", "scope", {
			begin: { intent: "work", budget: { read: 1 }, elder_report: null },
		});
		const [before, outsideRead, opened, insideRead, inside] = await runAssistant(host, ctx, assistant([
			call("t1", "todo", {
				op: "init",
				list: [{ phase: "P", items: ["finish the request"] }],
			}),
			call("r1", "read", { path: "outside" }),
			open,
			call("r2", "read", { path: "inside" }),
			call("t2", "todo", { op: "view" }),
		]), { prepareAll: true });
		expect(before.output.details.relay.firstEvaluation).toBe("nonempty");
		expect(outsideRead.result.content[0].text).toContain("Not in a scope");
		expect(opened.result.content[0].text).toContain("You are now inside this scope.");
		expect(insideRead.result.content[0].text).toBe("read ok");
		expect(inside.result.content[0].text).toContain("TODO_OUTSIDE_SCOPE_ONLY");

		const [closed, after, afterRead] = await runAssistant(host, ctx, assistant([
			call("e1", "scope", { end: true }),
			call("t3", "todo", { op: "view" }),
			call("r3", "read", { path: "closed" }),
		]), { prepareAll: true });
		expect(closed.result.content[0].text).toContain("You are outside all scopes.");
		expect(after.output.details.relay.lastLedger.open).toBe(1);
		expect(afterRead.result.content[0].text).toContain("Not in a scope");
	});

	test("a handoff requested by todo takes precedence over the next scope opening", async () => {
		const { host, ctx } = await start();
		const [todo, scope, read] = await runAssistant(host, ctx, assistant([
			call("t1", "todo", { op: "init", list: [] }),
			call("b1", "scope", {
				begin: { intent: "later", budget: { read: 1 }, elder_report: null },
			}),
			call("r1", "read", { path: "must-not-run" }),
		]), { prepareAll: true });
		expect(todo.output.details.relay.handoffPending).toBe(true);
		expect(scope.result.content[0].text).toContain("RELAY_HANDOFF_PENDING");
		expect(read.result.isError).toBe(true);
		expect(stateFor(ctx).state.scopes).toHaveLength(0);
	});

	test("the override keeps the native phases and appends relay details", async () => {
		const { host, ctx, native } = await start();
		const result = await runAssistant(
			host,
			ctx,
			assistant([
				call("t1", "todo", {
					op: "init",
					list: [{ phase: "P", items: ["finish the request"] }],
				}),
			]),
		);
		const output = result[0].output;
		expect(output.details.phases).toEqual(native.phases);
		expect(output.details.relay.generation).toBe(0);
		expect(output.details.relay.firstEvaluation).toBe("nonempty");
		expect(output.details.relay.canStop).toBe(false);
		expect(output.details.relay.lastLedger.open).toBe(1);
		expect(output.details.relay.promotionInvalidated).toBe(false);
		expect(output.details.relay.handoffError).toBeNull();
		expect(output.details.relay.lastHandoff).toBeNull();
		expect(output.content.at(-1).text).toContain("RELAY STATE");
		expect(output.content.at(-1).text).toContain("rework");

		const definition = host.tools.get("todo");
		expect(definition.description).toContain("forbidden inside any active scope");
		expect(definition.description).toContain("real built-in /handoff");
		expect(Object.hasOwn(definition, "alwaysAvailable")).toBe(false);
	});

	test("a non-empty outermost ledger forbids a natural stop with a nudge", async () => {
		const { host, ctx } = await start();
		await runAssistant(
			host,
			ctx,
			assistant([
				call("t1", "todo", {
					op: "init",
					list: [{ phase: "P", items: ["still open"] }],
				}),
			]),
		);
		host.steers.length = 0;
		await runAssistant(host, ctx, assistant([{ type: "text", text: "Done." }]));
		expect(host.steers.length).toBe(1);
		expect(host.steers[0].text).toContain("ledger is not empty");
		expect(host.steers[0].text).toContain("natural stop is forbidden");
	});

	test("session_stop can start a pending handoff if there is no next model call", async () => {
		const { host, ctx, session, aborts } = await start({ mode: "print" });
		const result = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const text = result[0].output.content.map((part) => part.text).join("\n");
		expect(session.calls.length).toBe(0);
		expect(aborts.length).toBe(0);
		expect(text).toContain("before the next model request");
		expect(text).not.toContain("You are the relay successor");
		expect(stateFor(ctx).state.relay.generation).toBe(0);

		const stop = await emitStop(host, ctx);
		expect(stop).toBeUndefined();
		expect(session.calls.length).toBe(1);
		expect(session.calls[0]).toContain("An empty ledger triggers a relay handoff");
		expect(session.calls[0]).toContain(
			"An empty ledger is a claim to audit, not evidence. If you find any gap, write it into todo and rework.",
		);
		expect(stateFor(ctx).state.relay.generation).toBe(1);
		expect(host.messages).toHaveLength(0);

		const view = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(view[0].output.details.relay.generation).toBe(1);

		// The successor's first empty evaluation promotes it. A second empty
		// evaluation must keep that promotion and must not force another handoff;
		// the promoted holder is the one that writes the final answer.
		const promoted = await runAssistant(
			host,
			ctx,
			assistant([call("t3", "todo", { op: "init", list: [] })]),
		);
		expect(promoted[0].output.details.relay.canStop).toBe(true);
		expect(promoted[0].output.details.relay.handoffPending).toBe(false);
		expect(session.calls.length).toBe(1);

		const repeated = await runAssistant(
			host,
			ctx,
			assistant([call("t4", "todo", { op: "init", list: [] })]),
		);
		expect(repeated[0].output.details.relay.canStop).toBe(true);
		expect(repeated[0].output.details.relay.handoffPending).toBe(false);
		expect(session.calls.length).toBe(1);
	});

	test("a failed stop handoff leaves the empty ledger for the next stop to retry", async () => {
		let attempts = 0;
		const { host, ctx, session } = await start({
			mode: "print",
			handoff: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("compaction already in progress");
				return { ok: true };
			},
		});
		const result = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		expect(result[0].output.content.at(-1).text).toContain("Handoff pending");
		expect(result[0].output.details.relay.generation).toBe(0);
		expect(session.calls.length).toBe(0);

		const first = await emitStop(host, ctx);
		expect(first).toBeUndefined();
		expect(session.calls.length).toBe(1);
		expect(stateFor(ctx).state.relay.handoffError).toContain("compaction already in progress");
		expect(host.messages.length).toBe(0);

		const second = await emitStop(host, ctx);
		expect(second).toBeUndefined();
		expect(session.calls.length).toBe(2);
		expect(host.messages).toHaveLength(0);
	});

	test("session_stop after a handoff asks the successor to evaluate", async () => {
		const { host, ctx, session } = await start({ mode: "rpc" });
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const stop = await emitStop(host, ctx);
		expect(stop).toBeUndefined();
		expect(session.calls.length).toBe(1);
		expect(host.messages).toHaveLength(0);
		const second = await emitStop(host, ctx);
		expect(second.continue).toBe(true);
		expect(second.additionalContext).toContain("evaluate the ledger with todo");
		expect(session.calls.length).toBe(1);
		expect(host.messages.some((entry) => entry.text.trim() === "/handoff")).toBe(false);
	});

	test("after handoff, a stop before the successor evaluates nudges instead of handing off again", async () => {
		const { host, ctx, session } = await start({ mode: "print" });
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const first = await emitStop(host, ctx);
		expect(first).toBeUndefined();
		expect(session.calls.length).toBe(1);
		expect(host.messages).toHaveLength(0);

		const second = await emitStop(host, ctx);
		expect(second.continue).toBe(true);
		expect(second.additionalContext).toContain("evaluate the ledger with todo");
		expect(session.calls.length).toBe(1);
	});

	test("generation 1 first empty ledger promotes and does not nudge", async () => {
		const { host, ctx } = await start({ mode: "rpc" });
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		await emitStop(host, ctx);
		const checked = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(checked[0].output.details.relay.generation).toBe(1);
		expect(checked[0].output.details.relay.canStop).toBe(false);
		expect(checked[0].output.details.relay.firstEvaluation).toBeNull();
		const promoted = await runAssistant(
			host,
			ctx,
			assistant([call("t3", "todo", { op: "init", list: [] })]),
		);
		expect(promoted[0].output.details.relay.canStop).toBe(true);
		expect(promoted[0].output.details.relay.firstEvaluation).toBe("empty");
		host.steers.length = 0;
		await runAssistant(host, ctx, assistant([{ type: "text", text: "Final." }]));
		expect(host.steers).toEqual([]);
		expect(await emitStop(host, ctx)).toBeUndefined();
	});

	test("generation 1 first non-empty ledger is rework, then empty hands off again", async () => {
		const { host, ctx, session, aborts } = await start({ mode: "rpc" });
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		await emitStop(host, ctx);
		expect(session.calls.length).toBe(1);

		const rework = await runAssistant(
			host,
			ctx,
			assistant([
				call("t2", "todo", {
					op: "init",
					list: [{ phase: "P", items: ["real work"] }],
				}),
			]),
		);
		expect(rework[0].output.details.relay.firstEvaluation).toBe("nonempty");
		expect(rework[0].output.content.at(-1).text).toContain("rework");
		expect(session.calls.length).toBe(1);

		const laterEmpty = await runAssistant(
			host,
			ctx,
			assistant([call("t3", "todo", { op: "init", list: [] })]),
		);
		expect(laterEmpty[0].output.details.relay.canStop).toBe(false);
		await emitStop(host, ctx);
		expect(session.calls.length).toBe(2);
		const view = await runAssistant(
			host,
			ctx,
			assistant([call("t4", "todo", { op: "view" })]),
		);
		expect(view[0].output.details.relay.generation).toBe(2);
		expect(aborts.length).toBe(0);
	});

	test("a failed inline handoff surfaces the error and the stop hook retries", async () => {
		const { host, ctx, session } = await start({
			mode: "print",
			handoff: () => {
				throw new Error("no model");
			},
		});
		const result = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		expect(result[0].output.content.at(-1).text).toContain("Handoff pending");
		expect(session.calls.length).toBe(0);
		const first = await emitStop(host, ctx);
		expect(first).toBeUndefined();
		expect(session.calls.length).toBe(1);
		const view = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(view[0].output.details.relay.generation).toBe(0);
		expect(view[0].output.content.at(-1).text).toContain("Last handoff error: no model");
	});

	test("an already-compacted handoff failure does not promote a successor", async () => {
		const { host, ctx } = await start({
			mode: "print",
			handoff: () => {
				throw new Error("Nothing to hand off (already compacted)");
			},
		});
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const rec = stateFor(ctx);
		expect(rec.state.relay.handoffPending).toBe(true);

		const first = await emitStop(host, ctx);
		expect(first).toBeUndefined();
		expect(rec.state.relay.generation).toBe(0);
		expect(rec.state.relay.canStop).toBe(false);
		expect(rec.state.relay.handoffError).toContain("already compacted");
		expect(host.messages).toHaveLength(0);
	});

	test("a handoff that returns success without advancing never allows a stop", async () => {
		const { host, ctx } = await start({ mode: "print" });
		host.pi.handoffImpl = async ({ rec }) => {
			// Simulate a host that reports success but clears the pending flag
			// before the runtime can advance the generation.
			rec.state.relay = { ...rec.state.relay, handoffPending: false };
			return { ok: true };
		};
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const stop = await emitStop(host, ctx);
		expect(stop).toBeUndefined();
		const rec = stateFor(ctx);
		expect(rec.state.relay.generation).toBe(0);
		expect(rec.state.relay.canStop).toBe(false);
		expect(rec.state.relay.handoffPending).toBe(false);
		expect(rec.state.relay.handoffError).toBe(
			"handoff completed but relay did not advance",
		);
		expect(rec.state.relay.lastHandoff.ok).toBe(false);
	});

	test("short-session recovery retries with identical instructions and no checkpoint", async () => {
		let started = null;
		let checkpointAtRetry = false;
		let checkpointInAgent = false;
		started = await start({
			mode: "print",
			handoff: ({ call: callNumber }) => {
				if (callNumber === 1) {
					throw new Error("Nothing to hand off (already compacted)");
				}
				checkpointAtRetry = started.manager.entries.some(
					(entry) =>
						entry.type === "message" &&
						entry.message?.role === "user" &&
						String(entry.message.content?.[0]?.text ?? "").includes(
							"Relay handoff audit checkpoint",
						),
				);
				checkpointInAgent = started.session.agent.state.messages.some(
					(message) =>
						JSON.stringify(message).includes("Relay handoff audit checkpoint"),
				);
				return { ok: true };
			},
		});
		await runAssistant(
			started.host,
			started.ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		expect(started.session.calls.length).toBe(0);
		const stop = await emitStop(started.host, started.ctx);
		expect(stop).toBeUndefined();
		expect(started.session.calls.length).toBe(2);
		expect(checkpointAtRetry).toBe(false);
		expect(checkpointInAgent).toBe(false);
		expect(started.session.calls[1]).toBe(started.session.calls[0]);
		expect(stateFor(started.ctx).state.relay.generation).toBe(1);
		expect(started.host.messages).toHaveLength(0);
	});

	test("the smaller retained tail is temporary", async () => {
		const { host, ctx, session } = await start({
			mode: "print",
			handoff: ({ call: callNumber }) => {
				if (callNumber === 1) {
					throw new Error("Nothing to hand off (already compacted)");
				}
				return { ok: true };
			},
		});
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		expect(session.calls.length).toBe(0);
		const stop = await emitStop(host, ctx);
		expect(stop).toBeUndefined();
		expect(session.calls.length).toBe(2);
		expect(session.settings.sets).toEqual([
			["compaction.keepRecentTokens", 1],
			["compaction.keepRecentTokens", 20000],
		]);
		expect(host.messages).toHaveLength(0);
	});

	test("print session_stop continues on scope, missing evaluation, and non-empty ledger", async () => {
		const noEvaluation = await start({ mode: "print" });
		const noEvalRec = stateFor(noEvaluation.ctx);
		noEvalRec.state.relay = {
			...noEvalRec.state.relay,
			generation: 0,
			firstEvaluation: null,
			canStop: false,
			handoffPending: false,
			promotionInvalidated: false,
			lastLedger: null,
			handoffError: null,
		};
		const unevaluated = await emitStop(noEvaluation.host, noEvaluation.ctx);
		expect(unevaluated.continue).toBe(true);
		expect(unevaluated.additionalContext).toContain("evaluate the ledger with todo");

		const nonEmpty = await start({ mode: "print" });
		await runAssistant(
			nonEmpty.host,
			nonEmpty.ctx,
			assistant([
				call("t1", "todo", {
					op: "init",
					list: [{ phase: "P", items: ["open"] }],
				}),
			]),
		);
		const open = await emitStop(nonEmpty.host, nonEmpty.ctx);
		expect(open.continue).toBe(true);
		expect(open.additionalContext).toContain("ledger is not empty");

		const inScope = await start({ mode: "print" });
		await runAssistant(
			inScope.host,
			inScope.ctx,
			assistant([call("b1", "scope", { begin: { intent: "work", budget: { read: 1 }, elder_report: null } })]),
		);
		const scoped = await emitStop(inScope.host, inScope.ctx);
		expect(scoped.continue).toBe(true);
		expect(scoped.additionalContext).toContain("still inside scope level 1");
	});

	test("scope begin is blocked while pending, then allowed for the successor", async () => {
		const { host, ctx } = await start({ mode: "rpc" });
		const rec = stateFor(ctx);
		rec.state.relay = { ...rec.state.relay, handoffPending: true };
		const blocked = await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", { begin: { intent: "early", budget: { read: 1 }, elder_report: null } })]),
		);
		expect(blocked[0].blocked).toBe(true);
		expect(blocked[0].result.content[0].text).toContain("RELAY_HANDOFF_PENDING");

		const fresh = await start({ mode: "rpc" });
		await runAssistant(
			fresh.host,
			fresh.ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const stop = await emitStop(fresh.host, fresh.ctx);
		expect(stop).toBeUndefined();
		expect(fresh.session.calls.length).toBe(1);
		const allowed = await runAssistant(
			fresh.host,
			fresh.ctx,
			assistant([call("b2", "scope", { begin: { intent: "audit", budget: { read: 1 }, elder_report: null } })]),
		);
		expect(allowed[0].blocked).toBe(false);
	});

	test("vibe mode keeps the todo override registered", async () => {
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
		const session = new Session(["read", "scope", "regret", "defer", "pin", "todo"]);
		await session.activateVibeTools(["read"]);
		expect(session.active).toEqual([
			"read",
			"scope",
			"regret",
			"defer",
			"pin",
			"todo",
			"task",
		]);
	});
});

describe("tui handoff integration", () => {
	function writesHandoffCompaction({ session }) {
		session.sessionManager.appendCompaction("handoff");
		return { ok: true };
	}

	function makeTui(session, options = {}) {
		const tui = {
			renders: 0,
			handoffCalls: [],
			async renderInitialMessages() {
				tui.renders += 1;
			},
			async handleHandoffCommand(focus) {
				tui.handoffCalls.push(focus);
				if (options.command) {
					return await options.command({ focus, tui, session });
				}
				await session.handoff(focus);
				await tui.renderInitialMessages();
			},
		};
		return tui;
	}

	function handoffSignal(manager) {
		return manager.entries.find(
			(entry) =>
				entry.type === "message" &&
				entry.message?.customType === "herd-relay-handoff",
		);
	}

	test("installInteractiveCapture remembers the live TUI instance", async () => {
		rememberTui(null);
		class FakeInteractiveMode {
			renders = 0;
			handoffs = [];
			async renderInitialMessages() {
				this.renders += 1;
			}
			async handleHandoffCommand(focus) {
				this.handoffs.push(focus);
			}
		}
		installInteractiveCapture(FakeInteractiveMode);
		const tui = new FakeInteractiveMode();
		expect(tuiFor()).toBeNull();
		await tui.handleHandoffCommand("x");
		expect(tuiFor()).toBe(tui);
		await tui.renderInitialMessages();
		installInteractiveCapture(FakeInteractiveMode);
		await tui.renderInitialMessages();
		expect(tui.renders).toBe(2);
		expect(tui.handoffs).toEqual(["x"]);
		rememberTui(null);
	});

	test("countHandoffCompactions counts only handoff methods", () => {
		const manager = makeManager();
		expect(countHandoffCompactions(null)).toBeNull();
		expect(countHandoffCompactions(manager)).toBe(0);
		manager.appendCompaction("handoff");
		manager.appendCompaction("soft");
		manager.appendCompaction(undefined, { method: "handoff" });
		expect(countHandoffCompactions(manager)).toBe(2);
	});

	test("the empty-ledger handoff rebuilds the TUI", async () => {
		const started = await start({ mode: "print", handoff: writesHandoffCompaction });
		const tui = makeTui(started.session);
		rememberTui(tui);
		try {
			const result = await runAssistant(
				started.host,
				started.ctx,
				assistant([call("t1", "todo", { op: "init", list: [] })]),
			);
			const text = result[0].output.content.map((part) => part.text).join("\n");
			expect(text).toContain("before the next model request");
			expect(text).not.toContain("You are the relay successor");
			expect(tui.handoffCalls.length).toBe(0);
			expect(started.session.calls.length).toBe(0);
			const stop = await emitStop(started.host, started.ctx);
			expect(stop).toBeUndefined();
			expect(tui.handoffCalls.length).toBe(0);
			expect(started.session.calls.length).toBe(1);
			expect(countHandoffCompactions(started.manager)).toBe(1);
			expect(tui.renders).toBe(1);
			expect(handoffSignal(started.manager)).toBeUndefined();
			expect(stateFor(started.ctx).state.relay.generation).toBe(1);
			expect(started.host.messages).toHaveLength(0);
		} finally {
			rememberTui(null);
		}
	});

	test("a failed handoff records failure and succeeds on retry via session.handoff + TUI render", async () => {
		const started = await start({
			mode: "print",
			handoff: ({ call: callNumber, session }) => {
				if (callNumber === 1) throw new Error("no model");
				session.sessionManager.appendCompaction("handoff");
				return { ok: true };
			},
		});
		const tui = makeTui(started.session);
		rememberTui(tui);
		try {
			const result = await runAssistant(
				started.host,
				started.ctx,
				assistant([call("t1", "todo", { op: "init", list: [] })]),
			);
			expect(result[0].output.content.at(-1).text).toContain("Handoff pending");
			expect(started.session.calls.length).toBe(0);

			const firstStop = await emitStop(started.host, started.ctx);
			expect(firstStop).toBeUndefined();
			expect(tui.handoffCalls.length).toBe(0);
			expect(started.session.calls.length).toBe(1);

			const secondStop = await emitStop(started.host, started.ctx);
			expect(secondStop).toBeUndefined();
			expect(started.session.calls.length).toBe(2);
			expect(tui.renders).toBe(1);
			expect(countHandoffCompactions(started.manager)).toBe(1);
			expect(stateFor(started.ctx).state.relay.generation).toBe(1);
			expect(started.host.messages).toHaveLength(0);
		} finally {
			rememberTui(null);
		}
	});


	test("a direct handoff with a captured TUI rebuilds the transcript", async () => {
		const started = await start({ mode: "print", handoff: writesHandoffCompaction });
		const tui = {
			renders: 0,
			async renderInitialMessages() {
				this.renders += 1;
			},
		};
		rememberTui(tui);
		try {
			const result = await runAssistant(
				started.host,
				started.ctx,
				assistant([call("t1", "todo", { op: "init", list: [] })]),
			);
			expect(result[0].output.content.at(-1).text).toContain("before the next model request");
			const stop = await emitStop(started.host, started.ctx);
			expect(stop).toBeUndefined();
			expect(started.session.calls.length).toBe(1);
			expect(tui.renders).toBe(1);
			expect(handoffSignal(started.manager)).toBeUndefined();
			expect(started.host.messages).toHaveLength(0);
		} finally {
			rememberTui(null);
		}
	});

	test("without a TUI, the handoff adds no separate transcript message", async () => {
		rememberTui(null);
		const started = await start({ mode: "print", handoff: writesHandoffCompaction });
		const result = await runAssistant(
			started.host,
			started.ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		expect(result[0].output.content.at(-1).text).toContain("before the next model request");
		const stop = await emitStop(started.host, started.ctx);
		expect(stop).toBeUndefined();
		expect(countHandoffCompactions(started.manager)).toBe(1);
		expect(handoffSignal(started.manager)).toBeUndefined();
		expect(started.host.messages).toHaveLength(0);
	});
});

describe("scope model switching", () => {
	const large = { provider: "fixture", id: "large", contextWindow: 100_000 };
	const small = { provider: "fixture", id: "small", contextWindow: 50_000 };
	const tiny = { provider: "fixture", id: "tiny", contextWindow: 10 };

	test("slash-only cannot fall through when a host executor declines or returns residual text", async () => {
		const { sendSlashPrompt } = await import("../src/host/capture.mjs");
		const deliveries = [];
		const session = { prompt: async (text) => { deliveries.push(text); } };
		for (const outcome of [false, "residual prompt"]) {
			const result = await sendSlashPrompt(session, "/switch unknown", {
				slashOnly: true,
				builtinExecutor: async () => outcome,
				fallbackSend: async (text) => { deliveries.push(text); },
			});
			expect(result.handled).toBe(false);
		}
		expect(deliveries).toEqual([]);
	});

	async function fixture() {
		const { host, ctx, session } = await start({ mode: "print" });
		const switches = [];
		const models = [large, small, tiny];
		session.model = large;
		session.modelRegistry = {
			getAll: () => models,
			find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
		};
		ctx.modelRegistry = session.modelRegistry;
		for (const name of ["setModel", "setModelTemporary"]) {
			session[name] = async (model) => {
				const target = typeof model === "string"
					? models.find((candidate) => `${candidate.provider}/${candidate.id}` === model)
					: model;
				if (!target) throw new Error("model not found");
				switches.push(target.id);
				session.model = target;
			};
		}
		const scope = async (id, args) => {
			const [entry] = await runAssistant(host, ctx, assistant([call(id, "scope", args)]));
			return entry.result;
		};
		const begin = (model, elder_report = null) => ({ intent: "model check", budget: { read: 1 }, model, elder_report });
		return { host, ctx, session, switches, scope, begin };
	}

	test("combined end/begin inherits the parent, not the closed sibling", async () => {
		const { ctx, session, switches, scope, begin } = await fixture();
		await scope("outer", { begin: begin(null) });
		const child = await scope("child", { begin: begin("fixture/small") });
		expect(child.details?.modelSwitch ?? null).toBeNull();
		expect(session.model).toBe(small);
		await scope("sibling", { end: true, begin: begin(null, "child completed") });
		expect(switches).toEqual(["small", "large"]);
		expect(session.model).toBe(large);
		expect(stateFor(ctx).state.scopes.at(-1).modelKey).toBe("fixture/large");
	});

	test("rejects an overfull combined begin without closing the active scope", async () => {
		const { ctx, switches, scope, begin } = await fixture();
		await scope("outer", { begin: begin(null) });
		const refused = await scope("overfull", { end: true, begin: begin("fixture/tiny", "done") });
		expect(refused.content.map((part) => part.text).join(" ")).toContain("MODEL_CONTEXT_EXCEEDED");
		expect(stateFor(ctx).state.scopes.map((active) => active.beginToolCallId)).toEqual(["outer"]);
		expect(switches).toEqual([]);
	});

	test("host truncation restores the surviving scope model", async () => {
		const { host, ctx, session, switches, scope, begin } = await fixture();
		await scope("outer", { begin: begin(null) });
		await scope("child", { begin: begin("fixture/small") });
		await emit(host.handlers, "session_compact", {}, ctx);
		expect(session.model).toBe(large);
		expect(switches).toEqual(["small", "large"]);
		expect(stateFor(ctx).state.scopes).toHaveLength(1);
	});

	test("before_agent_start restores the model when the handoff is only visible in history", async () => {
		const { host, ctx, session, switches, scope, begin } = await fixture();
		await scope("outer", { begin: begin(null) });
		await scope("child", { begin: begin("fixture/small") });
		ctx.sessionManager.appendMessage({ role: "custom", customType: "handoff", content: "handoff summary", timestamp: 42 });
		await emit(host.handlers, "before_agent_start", { systemPrompt: "base" }, ctx);
		expect(session.model).toBe(large);
		expect(switches).toEqual(["small", "large"]);
		expect(stateFor(ctx).state.scopes.map((active) => active.beginToolCallId)).toEqual(["outer"]);
	});

	test("return to a smaller parent floods older siblings but keeps the closing workbench", async () => {
		const { host, ctx, session, scope, begin } = await fixture();
		await scope("outer", { begin: begin("fixture/small") });
		await scope("old", { begin: begin(null) });
		await runAssistant(host, ctx, assistant([{ type: "text", text: "old interior to remove" }]));
		await scope("middle", { end: true, begin: begin(null, "archive ".repeat(100)) });
		await scope("wide", { end: true, begin: begin("fixture/large", "middle complete") });
		const records = () => stateFor(ctx).state.collapses;
		expect(records().find((record) => record.beginToolCallId === "old").collapsed).toBe(false);
		const workbench = "wide workbench " + "x".repeat(140_000);
		await runAssistant(host, ctx, assistant([{ type: "text", text: workbench }]));
		await scope("wide-end", { end: true });
		expect(session.model).toBe(small);
		const messages = ctx.sessionManager.buildSessionContext().messages;
		expect(messages.some((message) => message.content?.[0]?.text === "old interior to remove")).toBe(false);
		expect(messages.some((message) => message.content?.[0]?.text === workbench)).toBe(true);
		expect(records().find((record) => record.beginToolCallId === "wide").collapsed).toBe(false);
	});

	test("an unmatched selector never becomes a nested prompt", async () => {
		const { ctx, session, switches, scope, begin } = await fixture();
		let prompts = 0;
		session.prompt = async () => { prompts += 1; };
		const result = await scope("unknown", { begin: begin("unrecognized-fixture-selector") });
		expect(result.content.map((part) => part.text).join(" ")).toContain("WARNING:");
		expect(stateFor(ctx).state.scopes.at(-1).modelKey).toBe("fixture/large");
		expect(switches).toEqual([]);
		expect(prompts).toBe(0);
	});

	test("a scope closed under another tokenizer uses its interior characters", async () => {
		const { host, ctx, session, scope, begin } = await fixture();
		await scope("measured", { begin: begin(null) });
		const largeUsage = { ...assistant([{ type: "text", text: "a".repeat(500) }], 11),
			model: "large", provider: "fixture", usage: { input: 30_000, output: 10 } };
		await runAssistant(host, ctx, largeUsage);
		await scope("nested", { begin: begin("fixture/small") });
		const close = { ...assistant([call("nested-end", "scope", { end: true })], 12),
			model: "small", provider: "fixture", usage: { input: 900, output: 10 } };
		await runAssistant(host, ctx, close);
		session.model = small;
		await runAssistant(host, ctx, { ...assistant([call("measured-end", "scope", { end: true })], 13),
			model: "small", provider: "fixture", usage: { input: 1_000, output: 10 } });
		const { state } = stateFor(ctx);
		const record = state.collapses.find((item) => item.beginToolCallId === "measured");
		expect(record.baseModelKey).toBe("fixture/large");
		expect(record.measuredModelKey).toBe("fixture/small");
		expect(record.interiorTokens).toBe(Math.ceil(record.interiorChars * state.modelCaches["fixture/small"].tokensPerChar));
		expect(record.interiorTokens).toBeGreaterThan(0);
		expect(state.modelCaches["fixture/large"].cachedUntilPos).toBeLessThan(state.modelCaches["fixture/small"].cachedUntilPos);
	});

	for (const delayed of [false, true]) {
		test(`unidentified usage uses a character estimate (${delayed ? "late" : "immediate"})`, async () => {
			const { host, ctx, session, scope, begin } = await fixture();
			session.model = undefined;
			await scope("unidentified", { begin: begin(null) });
			await runAssistant(host, ctx, { ...assistant([{ type: "text", text: "interior ".repeat(80) }], 71), usage: { input: 20_000 } });
			const closing = assistant([call("unidentified-end", "scope", { end: true })], 72);
			const usage = { input: 10 };
			await runAssistant(host, ctx, delayed ? closing : { ...closing, usage });
			if (delayed) await emit(host.handlers, "message_end", { message: { ...closing, usage } }, ctx);
			const record = stateFor(ctx).state.collapses.find((item) => item.beginToolCallId === "unidentified");
			expect(record.baseInputTokens).toBe(20_000);
			expect(record.endInputTokens).toBe(10);
			expect(record.baseModelKey).toBeNull();
			expect(record.measuredModelKey).toBeNull();
			expect(record.interiorTokens).toBeGreaterThan(0);
		});
	}
});

describe("host truncation", () => {
	async function openNestedScopes() {
		const started = await start({ mode: "print" });
		await runAssistant(
			started.host,
			started.ctx,
			assistant([
				call("b1", "scope", {
					begin: { intent: "outer", budget: { read: 2 }, elder_report: null },
				}),
			]),
		);
		await runAssistant(
			started.host,
			started.ctx,
			assistant([
				call("b2", "scope", {
					begin: { intent: "inner", budget: { read: 2 }, elder_report: null },
				}),
			]),
		);
		expect(stateFor(started.ctx).state.scopes.length).toBe(2);
		return started;
	}

	test("a host compaction keeps only the outermost scope and advances the epoch", async () => {
		const { host, ctx } = await openNestedScopes();
		await emit(
			host.handlers,
			"session_compact",
			{
				type: "session_compact",
				compactionEntry: { type: "compaction", fromExtension: false },
			},
			ctx,
		);
		const state = stateFor(ctx).state;
		expect(state.epoch).toBe(1);
		expect(state.scopes.length).toBe(1);
		expect(state.scopes[0].intent).toBe("outer");
		expect(state.scopes[0].epoch).toBe(1);
	});

	test("a host handoff message truncates to the outermost scope", async () => {
		const { host, ctx } = await openNestedScopes();
		ctx.agentMessages.push({
			role: "custom",
			customType: "handoff",
			content: [
				{ type: "text", text: "<handoff-context>host handoff</handoff-context>" },
			],
			timestamp: 42,
		});
		await emit(host.handlers, "context", { messages: ctx.agentMessages }, ctx);
		const state = stateFor(ctx).state;
		expect(state.epoch).toBe(1);
		expect(state.scopes.length).toBe(1);
		expect(state.scopes[0].intent).toBe("outer");
	});

	test("a host session_switch handoff truncates without a relay handoff", async () => {
		const { host, ctx } = await openNestedScopes();
		await emit(
			host.handlers,
			"session_switch",
			{ type: "session_switch", reason: "handoff" },
			ctx,
		);
		const state = stateFor(ctx).state;
		expect(state.epoch).toBe(1);
		expect(state.scopes.length).toBe(1);
		expect(state.scopes[0].intent).toBe("outer");
	});
});

describe("slash-capable sendSlashPrompt (preserving original sendPrompt) across TUI, RPC, and Print modes", () => {
	test("original sendPrompt remains untouched while AgentSession.prototype.sendSlashPrompt dispatches '/handoff ...' uniformly to session.handoff across TUI, RPC, and Print", async () => {
		const handoffCalls = [];
		const { AgentSession, InteractiveMode } = await import(
			"../src/host/index.mjs"
		).then(async () => {
			class FakeAgentSession {
				constructor(sessionManager) {
					this.sessionManager = sessionManager;
					this.agent = { state: { isStreaming: false, messages: [] } };
					this._promptInFlight = 1;
				}
				get extensionRunner() {
					return null;
				}
				get isStreaming() {
					return this.agent.state.isStreaming || this._promptInFlight > 0;
				}
				async sendPrompt(text, options) {
					return { originalSendPrompt: text, options };
				}
				async prompt(text, options) {
					return { prompted: text, options };
				}
				async handoff(focus) {
					handoffCalls.push({ via: "session.handoff", focus });
					this.sessionManager.appendCompaction("handoff", { focus });
					return { ok: true };
				}
			}
			class FakeInteractiveMode {
				constructor(session) {
					this.session = session;
				}
				async renderInitialMessages() {}
				async handleHandoffCommand(focus) {
					if (this.session.isStreaming) {
						throw new Error("blocked by isStreaming");
					}
					handoffCalls.push({ via: "tui.handleHandoffCommand", focus });
					this.session.sessionManager.appendCompaction("handoff", { focus });
				}
			}
			return {
				AgentSession: FakeAgentSession,
				InteractiveMode: FakeInteractiveMode,
			};
		});

		const {
			installRunnerCapture,
			installInteractiveCapture,
			rememberTui,
		} = await import("../src/host/index.mjs");
		installRunnerCapture(AgentSession);
		installInteractiveCapture(InteractiveMode);

		const manager = makeManager();
		const session = new AgentSession(manager);
		const tui = new InteractiveMode(session);
		rememberTui(tui);

		// Original sendPrompt must remain completely unchanged (even for '/handoff ...').
		const untouched = await session.sendPrompt("/handoff should not trigger");
		expect(untouched).toEqual({
			originalSendPrompt: "/handoff should not trigger",
			options: undefined,
		});
		expect(handoffCalls).toEqual([]);

		// During session_stop: session.isStreaming is true because _promptInFlight > 0,
		// while agent.state.isStreaming is false. sendSlashPrompt('/handoff ...') routes
		// uniformly through session.handoff without touching tui.handleHandoffCommand or
		// mutating isStreaming.
		expect(session.isStreaming).toBe(true);
		const res = await session.sendSlashPrompt("/handoff verify tui focus");
		expect(res.handled).toBe(true);
		expect(res.mode).toBe("session");
		expect(handoffCalls).toEqual([
			{ via: "session.handoff", focus: "verify tui focus" },
		]);
		expect(session.isStreaming).toBe(true);

		// Non-handoff prompts/slash commands delegate natively to session.prompt().
		const plain = await session.sendSlashPrompt("/custom-cmd arg1");
		expect(plain.prompted).toBe("/custom-cmd arg1");
	});

	test("session_stop triggers '/handoff ...' across rpc and print modes without TUI", async () => {
		for (const mode of ["rpc", "print"]) {
			const focusSeen = [];
			const { host, ctx, manager } = await start({
				mode,
				handoff: async (focus) => {
					focusSeen.push(focus);
					manager.appendCompaction("handoff", { focus });
					return { ok: true };
				},
			});
			const rec = stateFor(ctx);
			await runAssistant(
				host,
				ctx,
				assistant([call("t1", "todo", { op: "init", list: [{ phase: "p1", items: ["a"] }] })]),
			);
			// Mark empty ledger pending directly for stop-path verification.
			rec.state.relay = {
				...rec.state.relay,
				handoffPending: true,
				lastLedger: { empty: true, phases: [] },
			};
			const stop = await emitStop(host, ctx);
			expect(stop).toBeUndefined();
			expect(focusSeen.length).toBe(1);
			expect(countHandoffCompactions(manager)).toBe(1);
			expect(host.messages).toHaveLength(0);
		}
	});

	test("fire-and-forget handoff returns immediately from session_stop and context even while handoff hangs", async () => {
		let resolveHandoff;
		const handoffGate = new Promise((resolve) => {
			resolveHandoff = resolve;
		});
		const { host, ctx, manager } = await start({
			mode: "rpc",
			handoff: async () => {
				await handoffGate;
				manager.appendCompaction("handoff", { focus: "slow" });
				return { ok: true };
			},
		});
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const stopResult = await emit(host.handlers, "session_stop", { type: "session_stop" }, ctx);
		expect(stopResult).toBeUndefined();
		const contextResult = await emit(host.handlers, "context", { messages: [] }, ctx);
		expect(contextResult).toBeDefined();
		expect(host.messages.length).toBe(0);

		resolveHandoff();
		await sleep(15);
		expect(stateFor(ctx).state.relay.generation).toBe(1);
		expect(host.messages).toHaveLength(0);
	});

	test.each([0, 1])("the first provider request after an empty ledger in generation %i belongs to its successor", async (generation) => {
		let resolveHandoff;
		let handoffStarted;
		const handoffGate = new Promise((resolve) => {
			resolveHandoff = resolve;
		});
		const started = new Promise((resolve) => {
			handoffStarted = resolve;
		});
		const persistenceStarted = Promise.withResolvers();
		const persistenceDone = Promise.withResolvers();
		const beforeModelCallHooks = [];
		const { host, ctx, manager, session } = await start({
			mode: "rpc",
			handoff: async () => {
				expect(manager.getBranch().some((entry) =>
					entry.message?.toolCallId === "empty",
				)).toBe(true);
				handoffStarted();
				await handoffGate;
				manager.appendCompaction("handoff", { focus: "slow" });
				session.agent.state.messages = [
					{ role: "user", content: [{ type: "text", text: "compacted summary" }] },
				];
				return { ok: true };
			},
		});
		session.agent = {
			state: { messages: [] },
			addBeforeModelCallHook: (hook) => {
				beforeModelCallHooks.push(hook);
				return () => {};
			},
		};
		session.settleInFlightMessagePersistence = () => {
			persistenceStarted.resolve();
			return persistenceDone.promise;
		};

		if (generation === 1) {
			const rec = stateFor(ctx);
			rec.state.relay = { ...rec.state.relay, generation };
			await runAssistant(host, ctx, assistant([
				call("open", "todo", { op: "init", list: [{ phase: "work", items: ["a"] }] }),
			]));
		}
		await runAssistant(
			host,
			ctx,
			assistant([call("empty", "todo", { op: "init", list: [] })]),
		);
		expect(beforeModelCallHooks.length).toBe(1);

		// omp runs the model gate before transformContext, not after it.
		const outboundContext = {
			messages: [{ role: "user", content: [{ type: "text", text: "stale history" }] }],
		};
		const providerRequests = [];
		const request = (async () => {
			for (const hook of beforeModelCallHooks) await hook(undefined, outboundContext);
			providerRequests.push(await emit(host.handlers, "context", outboundContext, ctx));
		})();
		await persistenceStarted.promise;
		expect(session.calls).toHaveLength(0);
		expect(providerRequests).toHaveLength(0);
		persistenceDone.resolve();
		await started;
		expect(providerRequests).toHaveLength(0);
		await emit(host.handlers, "session_switch", { reason: "handoff" }, ctx);
		expect(stateFor(ctx).state.relay.generation).toBe(generation);
		expect(await emit(host.handlers, "session_stop", { type: "session_stop" }, ctx))
			.toBeUndefined();

		resolveHandoff();
		await request;
		expect(providerRequests).toHaveLength(1);
		expect(session.calls).toHaveLength(1);
		expect(stateFor(ctx).state.relay.generation).toBe(generation + 1);
		const messages = providerRequests[0].messages;
		expect(messages[0].content[0].text).toBe("compacted summary");
		expect(JSON.stringify(messages)).not.toContain("stale history");
		const instruction = `Include these relay instructions in the handoff document for generation ${generation + 1}`;
		expect(session.calls[0]).toContain(instruction);
		expect(JSON.stringify(messages)).not.toContain(instruction);
		expect(JSON.stringify(manager.getBranch().filter((entry) => entry.type === "message"))).not.toContain(instruction);
		expect(host.messages).toHaveLength(0);
	});

	test("a failed handoff blocks the old request and the next attempt serves the successor", async () => {
		const { host, ctx, session } = await start({
			handoff: ({ call: attempt }) => {
				if (attempt === 1) throw new Error("handoff unavailable");
				return { ok: true };
			},
		});
		let gate;
		session.agent.addBeforeModelCallHook = (hook) => { gate = hook; };
		await runAssistant(host, ctx, assistant([call("empty", "todo", { op: "init", list: [] })]));
		const outbound = { messages: [] };
		await expect(gate(undefined, outbound)).rejects.toThrow("handoff unavailable");
		expect(stateFor(ctx).state.relay.generation).toBe(0);
		expect(outbound.messages).toHaveLength(0);
		expect(host.messages).toHaveLength(0);

		await gate(undefined, outbound);
		expect(stateFor(ctx).state.relay.generation).toBe(1);
		expect(outbound.messages).toHaveLength(0);
		expect(host.messages).toHaveLength(0);
	});

	test("a refused system slash command never falls through to a conversation prompt", async () => {
		const { host, ctx, session } = await start();
		let command;
		let options;
		let gate;
		session.agent.addBeforeModelCallHook = (hook) => { gate = hook; };
		session.sendSlashPrompt = async (text, params) => {
			command = text;
			options = params;
			return { handled: false, residual: text };
		};
		session.prompt = () => { throw new Error("unexpected conversation prompt"); };
		await runAssistant(host, ctx, assistant([call("empty", "todo", { op: "init", list: [] })]));
		await expect(gate(undefined, { messages: [] })).rejects.toThrow("system /handoff command did not complete");
		expect(command).toStartWith("/handoff Relay: empty-ledger handoff.");
		expect(command).toContain("You must independently verify the previous holder's work.");
		expect(options.slashOnly).toBe(true);
		expect(stateFor(ctx).state.relay.generation).toBe(0);
		expect(host.messages).toHaveLength(0);
	});

	test("idle fallback handoff does not send a user message or start a model call", async () => {
		const beforeModelCallHooks = [];
		let modelCalls = 0;
		const { host, ctx, manager, session } = await start({
			mode: "rpc",
			handoff: async () => {
				manager.appendCompaction("handoff", { focus: "successor" });
				session.agent.state.messages = [
					{ role: "user", content: [{ type: "text", text: "compacted" }] },
				];
				return { ok: true };
			},
		});
		session.agent = {
			state: { messages: [] },
			addBeforeModelCallHook: (hook) => {
				beforeModelCallHooks.push(hook);
				return () => {};
			},
		};
		const originalSend = host.pi.sendUserMessage;
		host.pi.sendUserMessage = async (text, options) => {
			originalSend(text, options);
			const outboundContext = {
				messages: [{ role: "user", content: [{ type: "text", text }] }],
			};
			await Promise.all(
				beforeModelCallHooks.map((hook) => hook(undefined, outboundContext)),
			);
			modelCalls += 1;
		};

		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const stopResult = await emitStop(host, ctx);
		expect(stopResult).toBeUndefined();
		expect(stateFor(ctx).state.relay.generation).toBe(1);
		expect(host.messages).toHaveLength(0);
		expect(modelCalls).toBe(0);
	});

	test("Headless TUI Adapter supports /vibe, /vibe <prompt>, /new, /fresh, and arbitrary slash commands uniformly", async () => {
		const events = [];
		const modeChanges = [];
		const session = {
			isStreaming: false,
			sessionManager: {
				appendModeChange: (mode, meta) => modeChanges.push({ mode, meta }),
			},
			getEnabledToolNames: () => ["read", "bash", "edit"],
			hasBuiltInTool: (name) => name === "todo",
			activateVibeTools: async (base) => {
				events.push({ op: "activateVibeTools", base });
			},
			deactivateVibeTools: async (prev) => {
				events.push({ op: "deactivateVibeTools", prev });
			},
			setVibeModeState: (state) => {
				events.push({ op: "setVibeModeState", state });
			},
			runModeExitTeardown: async (fn) => {
				events.push({ op: "runModeExitTeardown" });
				await fn();
			},
			newSession: async () => {
				events.push({ op: "newSession" });
				return true;
			},
			freshSession: () => {
				events.push({ op: "freshSession" });
				return { refreshed: true };
			},
			prompt: async (text) => {
				events.push({ op: "prompt", text });
				return { prompted: text };
			},
		};

		const { sendSlashPrompt } = await import("../src/host/index.mjs");

		// 1. Toggle /vibe on
		const vibeOn = await sendSlashPrompt(session, "/vibe");
		expect(vibeOn.handled).toBe(true);
		expect(vibeOn.command).toBe("vibe");
		expect(modeChanges).toEqual([
			{ mode: "vibe", meta: { previousTools: ["read", "bash", "edit"] } },
		]);
		expect(events).toContainEqual({
			op: "activateVibeTools",
			base: ["read", "todo"],
		});
		expect(events).toContainEqual({
			op: "setVibeModeState",
			state: { enabled: true },
		});

		// 2. Toggle /vibe off
		const vibeOff = await sendSlashPrompt(session, "/vibe");
		expect(vibeOff.handled).toBe(true);
		expect(events).toContainEqual({ op: "runModeExitTeardown" });
		expect(events).toContainEqual({
			op: "deactivateVibeTools",
			prev: ["read", "bash", "edit"],
		});
		expect(events).toContainEqual({
			op: "setVibeModeState",
			state: undefined,
		});

		// 3. /vibe <prompt> enters vibe mode and delivers the prompt
		const vibePrompt = await sendSlashPrompt(session, "/vibe inspect src/main.mjs");
		expect(vibePrompt.handled).toBe(true);
		expect(events).toContainEqual({
			op: "prompt",
			text: "inspect src/main.mjs",
		});

		// 4. /new and /fresh work through the same Headless TUI Adapter
		const newRes = await sendSlashPrompt(session, "/new");
		expect(newRes.handled).toBe(true);
		expect(newRes.result).toEqual({ newSession: true });

		const freshRes = await sendSlashPrompt(session, "/fresh");
		expect(freshRes.handled).toBe(true);
		expect(freshRes.result).toEqual({ refreshed: true });

		// 5. Arbitrary slash command handled by host executor (consumed vs residual prompt)
		const consumed = await sendSlashPrompt(session, "/model sonnet", {
			builtinExecutor: async (raw, runtime) => {
				expect(raw).toBe("/model sonnet");
				runtime.ctx.showStatus("Model switched to sonnet");
				return true;
			},
		});
		expect(consumed.handled).toBe(true);
		expect(consumed.outputs).toEqual([
			{ kind: "status", text: "Model switched to sonnet" },
		]);

		const residual = await sendSlashPrompt(session, "/think:high solve it", {
			builtinExecutor: async () => "solve it",
		});
		expect(residual).toEqual({ prompted: "solve it" });
	});
});
