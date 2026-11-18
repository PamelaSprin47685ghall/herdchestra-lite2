/**
 * Relay integration: real hooks, real todo wrapper, fake native todo, and a
 * fake AgentSession.handoff(). An empty ledger only marks the relay pending;
 * the next context hook runs the real handoff and returns the post-handoff
 * transcript, so the next LLM request is the successor's first turn.
 * session_stop remains the retry path when the context hook fails.
 */

import { describe, expect, test } from "bun:test";
import {
	countHandoffCompactions,
	runHandoffInContext,
} from "../src/handoff.mjs";
import { activate } from "../src/main.mjs";
import {
	installInteractiveCapture,
	installVibeTools,
	rememberSession,
	rememberTui,
	tuiFor,
} from "../src/runner-capture.mjs";
import { stateFor } from "../src/runtime.mjs";

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
		agent: { state: { messages: [] } },
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

async function runAssistant(host, ctx, message) {
	await emit(
		host.handlers,
		"assistant_message",
		{ type: "assistant_message", message },
		ctx,
	);
	ctx.sessionManager.appendMessage(message);
	ctx.agentMessages.push(message);
	const results = [];
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const decision = await emit(
			host.handlers,
			"tool_call",
			{
				type: "tool_call",
				toolCallId: block.id,
				toolName: block.name,
				input: block.arguments,
			},
			ctx,
		);
		if (decision?.block) {
			const result = toolResult(block.id, block.name, decision.reason, true);
			ctx.sessionManager.appendMessage(result);
			ctx.agentMessages.push(result);
			results.push({ result, blocked: true });
			continue;
		}
		const tool = host.tools.get(block.name);
		const output = tool
			? await tool.execute(block.id, block.arguments, undefined, undefined, ctx)
			: { content: [{ type: "text", text: `${block.name} ok` }] };
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
		if (block.name === "todo" && output.details?.relay?.handoffPending === true) {
			results[results.length - 1].context = await emit(
				host.handlers,
				"context",
				{ messages: ctx.agentMessages },
				ctx,
			);
		}
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
	await sleep(0);
	return result;
}

function successorMessages(host) {
	return host.messages.filter((entry) =>
		entry.text.includes("You are the relay successor"),
	);
}

describe("relay integration", () => {
	test("a context handoff with fewer than two messages waits for session_stop", async () => {
		const { host, ctx, session } = await start({ mode: "print" });
		ctx.sessionManager.entries.length = 0;
		ctx.sessionManager.resetLeaf();
		const rec = stateFor(ctx);
		const outcome = await runHandoffInContext(rec, ctx, host.pi);
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("too few messages");
		expect(session.calls.length).toBe(0);
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

	test("todo is blocked inside a scope and free outside; other tools stay gated", async () => {
		const { host, ctx } = await start();
		await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", { begin: { intent: "work", budget: { read: 1 } } })]),
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
			assistant([call("e1", "scope", { end: "done" })]),
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

	test("todo empty lets generation 0 speak, then session_stop runs the real handoff", async () => {
		const { host, ctx, session, aborts } = await start({ mode: "print" });
		const result = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const text = result[0].output.content.map((part) => part.text).join("\n");
		expect(session.calls.length).toBe(0);
		expect(aborts.length).toBe(0);
		expect(result[0].context).toBeDefined();
		expect(JSON.stringify(result[0].context.messages)).toContain(
			"Finish your reply to the user now",
		);
		expect(text).toContain("Handoff is pending");
		expect(text).toContain("Finish your reply to the user now");
		expect(text).not.toContain("You are the relay successor");
		expect(stateFor(ctx).state.relay.generation).toBe(0);

		const stop = await emitStop(host, ctx);
		expect(stop.continue).toBe(true);
		expect(stop.additionalContext).toContain("You are the relay successor");
		expect(session.calls.length).toBe(1);
		expect(session.calls[0]).toContain("An empty ledger triggers a relay handoff");
		expect(session.calls[0]).toContain(
			"An empty ledger is a claim to audit, not evidence. If you find any gap, write it into todo and rework.",
		);
		expect(stateFor(ctx).state.relay.generation).toBe(1);
		expect(host.messages.length).toBe(0);
		expect(host.messages.some((entry) => entry.text.trim() === "/handoff")).toBe(false);

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
		expect(result[0].output.content.at(-1).text).toContain("Handoff is pending");
		expect(result[0].output.details.relay.generation).toBe(0);
		expect(session.calls.length).toBe(0);

		const first = await emitStop(host, ctx);
		expect(first.continue).toBe(true);
		expect(first.additionalContext).toContain("HANDOFF FAILED: compaction already in progress");
		expect(session.calls.length).toBe(1);

		const second = await emitStop(host, ctx);
		expect(second.continue).toBe(true);
		expect(second.additionalContext).toContain("You are the relay successor");
		expect(session.calls.length).toBe(2);
	});

	test("session_stop after a handoff asks the successor to evaluate", async () => {
		const { host, ctx, session } = await start({ mode: "rpc" });
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const stop = await emitStop(host, ctx);
		expect(stop.continue).toBe(true);
		expect(stop.additionalContext).toContain("You are the relay successor");
		expect(session.calls.length).toBe(1);
		const second = await emitStop(host, ctx);
		expect(second.continue).toBe(true);
		expect(second.additionalContext).toContain("evaluate the ledger with todo");
		expect(session.calls.length).toBe(1);
		expect(host.messages.length).toBe(0);
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
		expect(first.continue).toBe(true);
		expect(session.calls.length).toBe(1);

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
		expect(result[0].output.content.at(-1).text).toContain("Handoff is pending");
		expect(session.calls.length).toBe(0);
		const first = await emitStop(host, ctx);
		expect(first.continue).toBe(true);
		expect(first.additionalContext).toContain("HANDOFF FAILED: no model");
		expect(session.calls.length).toBe(1);
		const view = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(view[0].output.details.relay.generation).toBe(0);
		expect(view[0].output.content.at(-1).text).toContain("Last handoff error: no model");
	});

	test("an already-compacted handoff is terminal, advances once, and unblocks the relay", async () => {
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
		expect(first.continue).toBe(true);
		expect(first.additionalContext).toContain(
			"You are the relay successor (generation 1)",
		);
		expect(first.additionalContext).not.toContain("HANDOFF FAILED");
		expect(rec.state.relay.generation).toBe(1);
		expect(rec.state.relay.handoffPending).toBe(false);
		expect(rec.state.relay.handoffError).toBeNull();

		// The successor has not evaluated yet, so a second stop must not run
		// another handoff or advance the generation.
		await emitStop(host, ctx);
		expect(rec.state.relay.generation).toBe(1);

		// Even with pending re-armed, an already-compacted host is terminal: the
		// idempotent advance runs at most once, and a todo view stays available
		// as the diagnostic entry point.
		rec.state.relay = { ...rec.state.relay, handoffPending: true };
		const view = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(view[0].blocked).toBe(false);
		expect(view[0].output.content.at(-1).text).toContain("RELAY STATE");
		expect(rec.state.relay.generation).toBe(1);
		expect(rec.state.relay.handoffPending).toBe(false);

		const write = await runAssistant(
			host,
			ctx,
			assistant([call("t3", "todo", { op: "init", list: [] })]),
		);
		expect(write[0].blocked).toBe(false);
		expect(write[0].output.details.relay.canStop).toBe(true);

		const opened = await runAssistant(
			host,
			ctx,
			assistant([
				call("s1", "scope", {
					begin: {
						intent: "verify the unblocked relay",
						budget: { read: 1 },
					},
				}),
			]),
		);
		expect(opened[0].blocked).toBe(false);
		expect(stateFor(ctx).state.scopes.length).toBe(1);
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
		expect(stop).toBeDefined();
		expect(stop.continue).toBe(true);
		expect(stop.additionalContext).toContain(
			"HANDOFF FAILED: handoff completed but relay did not advance",
		);
		const rec = stateFor(ctx);
		expect(rec.state.relay.generation).toBe(0);
		expect(rec.state.relay.handoffPending).toBe(false);
		expect(rec.state.relay.handoffError).toBe(
			"handoff completed but relay did not advance",
		);
		expect(rec.state.relay.lastHandoff.ok).toBe(false);
	});

	test("short-session recovery appends a real user checkpoint before retrying", async () => {
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
		expect(stop.continue).toBe(true);
		expect(stop.additionalContext).toContain("You are the relay successor");
		expect(started.session.calls.length).toBe(2);
		expect(checkpointAtRetry).toBe(true);
		expect(checkpointInAgent).toBe(true);
		expect(started.session.settings.sets).toEqual([]);
		expect(stateFor(started.ctx).state.relay.generation).toBe(1);
	});

	test("when the checkpoint is not enough, keepRecentTokens is temporary", async () => {
		const { host, ctx, session } = await start({
			mode: "print",
			handoff: ({ call: callNumber }) => {
				if (callNumber <= 2) {
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
		expect(stop.continue).toBe(true);
		expect(stop.additionalContext).toContain("You are the relay successor");
		expect(session.calls.length).toBe(3);
		expect(session.settings.sets).toEqual([
			["compaction.keepRecentTokens", 1],
			["compaction.keepRecentTokens", 20000],
		]);
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
			assistant([call("b1", "scope", { begin: { intent: "work", budget: { read: 1 } } })]),
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
			assistant([call("b1", "scope", { begin: { intent: "early", budget: { read: 1 } } })]),
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
		expect(stop.continue).toBe(true);
		expect(fresh.session.calls.length).toBe(1);
		const allowed = await runAssistant(
			fresh.host,
			fresh.ctx,
			assistant([call("b2", "scope", { begin: { intent: "audit", budget: { read: 1 } } })]),
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

	test("the empty-ledger handoff runs before the tool result and rebuilds the TUI", async () => {
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
			expect(text).toContain("Handoff is pending");
			expect(text).toContain("Finish your reply to the user now");
			expect(text).not.toContain("You are the relay successor");
			expect(tui.handoffCalls.length).toBe(0);
			expect(started.session.calls.length).toBe(0);
			const stop = await emitStop(started.host, started.ctx);
			expect(stop.continue).toBe(true);
			expect(stop.additionalContext).toContain("You are the relay successor");
			expect(tui.handoffCalls.length).toBe(1);
			expect(started.session.calls.length).toBe(1);
			expect(countHandoffCompactions(started.manager)).toBe(1);
			expect(tui.renders).toBe(1);
			expect(handoffSignal(started.manager)).toBeUndefined();
			expect(stateFor(started.ctx).state.relay.generation).toBe(1);
			expect(
				started.host.messages.some((entry) => entry.text.trim() === "/handoff"),
			).toBe(false);
		} finally {
			rememberTui(null);
		}
	});

	test("a failed inline handoff falls back to the TUI command at stop", async () => {
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
			expect(result[0].output.content.at(-1).text).toContain("Handoff is pending");
			expect(started.session.calls.length).toBe(0);

			const stop = await emitStop(started.host, started.ctx);
			expect(stop.continue).toBe(true);
			expect(stop.additionalContext).toContain("You are the relay successor");
			expect(tui.handoffCalls.length).toBe(1);
			expect(started.session.calls.length).toBe(2);
			expect(countHandoffCompactions(started.manager)).toBe(1);
			expect(stateFor(started.ctx).state.relay.generation).toBe(1);
		} finally {
			rememberTui(null);
		}
	});

	test("a TUI command with no compaction entry fails instead of faking success", async () => {
		const started = await start({
			mode: "print",
			handoff: () => ({ ok: true }),
		});
		const tui = makeTui(started.session, { command: async () => {} });
		rememberTui(tui);
		try {
			await runAssistant(
				started.host,
				started.ctx,
				assistant([call("t1", "todo", { op: "init", list: [] })]),
			);
			const stop = await emitStop(started.host, started.ctx);
			expect(stop.continue).toBe(true);
			expect(stop.additionalContext).toContain(
				"HANDOFF FAILED: handoff did not add a compaction entry",
			);
			expect(started.session.calls.length).toBe(1);
			const rec = stateFor(started.ctx);
			expect(rec.state.relay.generation).toBe(0);
			expect(rec.state.relay.lastHandoff.ok).toBe(false);
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
			expect(result[0].output.content.at(-1).text).toContain("Finish your reply to the user now");
			const stop = await emitStop(started.host, started.ctx);
			expect(stop.continue).toBe(true);
			expect(stop.additionalContext).toContain("You are the relay successor");
			expect(started.session.calls.length).toBe(1);
			expect(tui.renders).toBe(1);
			expect(handoffSignal(started.manager)).toBeUndefined();
		} finally {
			rememberTui(null);
		}
	});

	test("without a TUI, success appends a visible handoff signal", async () => {
		rememberTui(null);
		const started = await start({ mode: "print", handoff: writesHandoffCompaction });
		const result = await runAssistant(
			started.host,
			started.ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		expect(result[0].output.content.at(-1).text).toContain("Finish your reply to the user now");
		const stop = await emitStop(started.host, started.ctx);
		expect(stop.continue).toBe(true);
		expect(stop.additionalContext).toContain("You are the relay successor");
		const signal = handoffSignal(started.manager);
		expect(signal).toBeDefined();
		expect(signal.message.display).toBe(true);
		expect(signal.message.content[0].text).toBe(
			"Handoff complete: generation 1 -> successor evaluating",
		);
	});
});

describe("host truncation", () => {
	async function openNestedScopes() {
		const started = await start({ mode: "print" });
		await runAssistant(
			started.host,
			started.ctx,
			assistant([
				call("b1", "scope", {
					begin: { intent: "outer", budget: { read: 2 } },
				}),
			]),
		);
		await runAssistant(
			started.host,
			started.ctx,
			assistant([
				call("b2", "scope", {
					begin: { intent: "inner", budget: { read: 2 } },
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
