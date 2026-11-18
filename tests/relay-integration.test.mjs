/**
 * Relay integration: real hooks, real todo wrapper, fake native todo, and a
 * fake AgentSession.handoff(). The handoff executes in session_stop, never in
 * the todo execute body, so print mode cannot deadlock on a streaming turn.
 */

import { describe, expect, test } from "bun:test";
import { countHandoffCompactions } from "../src/handoff.mjs";
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
	};
	return { pi, handlers, tools, steers, messages };
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
	const ctx = {
		sessionManager: manager,
		agentMessages: [],
		mode: options.mode ?? "rpc",
		invokeTool: (params) => native.execute(params),
	};
	const user = { role: "user", content: "do the task", timestamp: Date.now() };
	manager.appendMessage(user);
	ctx.agentMessages.push(user);
	return { host, ctx, manager, native, session };
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

	test("todo empty only marks pending; print session_stop returns continuation", async () => {
		const { host, ctx, session } = await start({ mode: "print" });
		const result = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		expect(result[0].output.content.at(-1).text).toContain("Handoff is pending");
		expect(result[0].output.content.at(-1).text).toContain("Stop now");
		expect(session.calls.length).toBe(0);

		const stop = await emitStop(host, ctx);
		expect(stop.continue).toBe(true);
		expect(stop.additionalContext).toContain("You are the relay successor");
		expect(stop.additionalContext).toContain(
			"Only a successor whose first todo evaluation is an empty ledger may stop naturally",
		);
		expect(stop.additionalContext).toContain(
			"You must independently verify the previous holder's work. Do not trust its empty ledger or its conclusion.",
		);
		expect(session.calls.length).toBe(1);
		expect(session.calls[0]).toContain("An empty ledger triggers a relay handoff");
		expect(session.calls[0]).toContain(
			"An empty ledger is a claim to audit, not evidence. If you find any gap, write it into todo and rework.",
		);
		expect(host.messages.length).toBe(0);
		expect(host.messages.some((entry) => entry.text.trim() === "/handoff")).toBe(false);

		const view = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(view[0].output.details.relay.generation).toBe(1);
	});

	test("all modes use the session_stop continuation for the successor prompt", async () => {
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
		const { host, ctx, session } = await start({ mode: "rpc" });
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
	});

	test("a failed handoff nudges, and the next stop retries once", async () => {
		const { host, ctx, session } = await start({
			mode: "print",
			handoff: () => {
				throw new Error("no model");
			},
		});
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const first = await emitStop(host, ctx);
		expect(first.continue).toBe(true);
		expect(first.additionalContext).toContain("HANDOFF FAILED: no model");
		expect(session.calls.length).toBe(1);
		const second = await emitStop(host, ctx);
		expect(second.continue).toBe(true);
		expect(second.additionalContext).toContain("HANDOFF FAILED: no model");
		expect(session.calls.length).toBe(2);
		const view = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(view[0].output.details.relay.generation).toBe(0);
		expect(view[0].output.content.at(-1).text).toContain("Last handoff error: no model");
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
				return { ok: true };
			},
		});
		await runAssistant(
			started.host,
			started.ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const stop = await emitStop(started.host, started.ctx);
		expect(stop.continue).toBe(true);
		expect(stop.additionalContext).toContain("You are the relay successor");
		expect(started.session.calls.length).toBe(2);
		expect(checkpointAtRetry).toBe(true);
		expect(started.session.settings.sets).toEqual([]);
		const view = await runAssistant(
			started.host,
			started.ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(view[0].output.details.relay.generation).toBe(1);
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

	test("scope begin is blocked while a handoff is pending", async () => {
		const { host, ctx, session } = await start({ mode: "rpc" });
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const begin = await runAssistant(
			host,
			ctx,
			assistant([call("b1", "scope", { begin: { intent: "early", budget: { read: 1 } } })]),
		);
		expect(begin[0].blocked).toBe(true);
		expect(begin[0].result.content[0].text).toContain("RELAY_HANDOFF_PENDING");
		expect(session.calls.length).toBe(0);
		await emitStop(host, ctx);
		expect(session.calls.length).toBe(1);
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

	test("the TUI handoff command runs the real session handoff and returns continuation", async () => {
		const started = await start({ mode: "print", handoff: writesHandoffCompaction });
		const tui = makeTui(started.session);
		rememberTui(tui);
		try {
			await runAssistant(
				started.host,
				started.ctx,
				assistant([call("t1", "todo", { op: "init", list: [] })]),
			);
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

	test("a failing TUI command falls back to the real handoff and rebuilds", async () => {
		const started = await start({ mode: "print", handoff: writesHandoffCompaction });
		const tui = makeTui(started.session, {
			command: () => {
				throw new Error("command exploded");
			},
		});
		rememberTui(tui);
		try {
			await runAssistant(
				started.host,
				started.ctx,
				assistant([call("t1", "todo", { op: "init", list: [] })]),
			);
			const stop = await emitStop(started.host, started.ctx);
			expect(stop.continue).toBe(true);
			expect(stop.additionalContext).toContain("You are the relay successor");
			expect(tui.handoffCalls.length).toBe(1);
			expect(started.session.calls.length).toBe(1);
			expect(tui.renders).toBe(1);
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
			await runAssistant(
				started.host,
				started.ctx,
				assistant([call("t1", "todo", { op: "init", list: [] })]),
			);
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
		await runAssistant(
			started.host,
			started.ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
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
