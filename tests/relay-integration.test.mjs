/**
 * Relay integration: real hooks, real todo wrapper, fake native todo, and a
 * fake AgentSession.compact(). The awaited before-model-call hook runs the
 * system /handoff and lets the same request continue on the compacted
 * transcript.
 */

import { describe, expect, test } from "bun:test";
import { countHandoffCompactions } from "../src/handoff/index.mjs";
import { activate } from "../src/main.mjs";
import {
	installBuiltinSlashExecutor,
	installVibeTools,
	parseSlashCommand,
	rememberSession,
	sessionFor,
} from "../src/host/index.mjs";
import { createStationRegistry, stateFor } from "../src/station/index.mjs";
import { scopeParameters } from "../src/tools/descriptions.mjs";
import { beginGenerationAfterHandoff } from "../src/relay/index.mjs";
import { allStagesRan } from "./helpers/stage-flags.mjs";

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
			const branch = manager.getBranch();
			let lastCompactionIdx = -1;
			for (let i = branch.length - 1; i >= 0; i -= 1) {
				if (branch[i].type === "compaction") {
					lastCompactionIdx = i;
					break;
				}
			}
			const messages = [];
			if (lastCompactionIdx >= 0) {
				const c = branch[lastCompactionIdx];
				const summary = c.details?.summary ?? c.details?.focus ?? "";
				if (summary) {
					messages.push({
						role: "compactionSummary",
						content: [{ type: "text", text: summary }],
						timestamp: Date.now(),
					});
				}
			}
			for (let i = lastCompactionIdx + 1; i < branch.length; i += 1) {
				const entry = branch[i];
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
	const beforeModelCallHooks = [];
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
			addBeforeModelCall(gate) {
				beforeModelCallHooks.push(gate);
				return () => {};
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
		async compact(focus, compactOptions = {}) {
			session.calls.push(focus);
			if (compactOptions.mode !== "handoff") {
				throw new Error(`unexpected compaction mode: ${compactOptions.mode}`);
			}
			const before = countHandoffCompactions(manager) ?? 0;
			const result =
				typeof options.handoff === "function"
					? await options.handoff({ focus, session, call: session.calls.length })
					: { ok: true };
			if (options.appendHandoff !== false) {
				const after = countHandoffCompactions(manager) ?? 0;
				if (after <= before) manager.appendCompaction("handoff", { focus });
			}
			return result;
		},
	};
	rememberSession(session);
	await activate(host.pi);
	installBuiltinSlashExecutor(async (text, runtime) => {
		const parsed = parseSlashCommand(text);
		if (!parsed) return false;
		if (parsed.name === "handoff") {
			await runtime.ctx.handleCompactCommand(parsed.args, "handoff");
			return true;
		}
		if (parsed.name === "switch" || parsed.name === "model") {
			const outcome = await runtime.ctx.onSwitchModel(parsed.args);
			return outcome?.handled === true;
		}
		return false;
	});
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
	stateFor(ctx).state.stageFlags = allStagesRan();
	if (options.sessionInit) manager.appendSessionInit(options.sessionInit);
	const user = { role: "user", content: "do the task", timestamp: Date.now() };
	manager.appendMessage(user);
	ctx.agentMessages.push(user);
	return { host, ctx, manager, native, session, aborts, beforeModelCallHooks };
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
				tools: ["read", "grep", "glob", "scope", "pin", "defer", "amend"],
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
			assistant([call("b1", "scope", { begin: { intent: "work", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "ro" } })]),
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
		const open = call("b1", "scope", { begin: { intent: "work", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "ro" } });
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
			call("b1", "scope", { begin: { intent: "later", stage: "architecture-design", budget: { read: 1 }, elder_report: null, permission: "ro" } }),
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
		expect(definition.description).toContain("write the handoff report in your message body");
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

	test("empty ledger demands body handoff report, blocks all tools, places compaction boundary, and hands off to successor", async () => {
		const { host, ctx, manager, session } = await start({ mode: "print" });
		const result = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		const text = result[0].output.content.map((part) => part.text).join("\n");
		expect(text).toContain("DO NOT call any more tools");
		expect(text).toContain("Write the handoff report immediately in your message body");
		expect(stateFor(ctx).state.relay.generation).toBe(0);
		expect(stateFor(ctx).state.relay.handoffPending).toBe(true);

		const blockedCalls = await runAssistant(
			host,
			ctx,
			assistant([
				call("t_view", "todo", { op: "view" }),
				call("s_begin", "scope", { begin: { intent: "sneak", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "ro" } }),
				call("r_read", "read", { path: "a" }),
			]),
		);
		expect(blockedCalls.every((entry) => entry.blocked)).toBe(true);
		expect(blockedCalls[0].result.content[0].text).toContain("RELAY_HANDOFF_PENDING");
		expect(blockedCalls[1].result.content[0].text).toContain("RELAY_HANDOFF_PENDING");
		expect(blockedCalls[2].result.content[0].text).toContain("RELAY_HANDOFF_PENDING");

		const missingReportStop = await emitStop(host, ctx);
		expect(missingReportStop.continue).toBe(true);
		expect(missingReportStop.additionalContext).toContain("have not written the handoff report yet");

		const reportBody = "## Handoff Report\n- Implemented feature X\n- Verified with tests";
		host.steers.length = 0;
		await runAssistant(host, ctx, assistant([{ type: "text", text: reportBody }]));
		expect(host.steers).toHaveLength(0);

		const stop = await emitStop(host, ctx);
		expect(stop.continue).toBe(true);
		expect(stop.additionalContext).toContain("Generation 1 takeover");
		expect(stateFor(ctx).state.relay.generation).toBe(1);
		expect(stateFor(ctx).state.relay.handoffPending).toBe(false);
		expect(countHandoffCompactions(manager)).toBe(1);
		expect(session.agent.state.messages[0].content[0].text).toContain(reportBody);
		expect(session.agent.state.messages[0].content[0].text).toContain("Your mandate has two halves");
		expect(session.agent.state.messages[0].content[0].text).toContain(
			"You serve the user, not the previous holder.",
		);

		const view = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(view[0].output.details.relay.generation).toBe(1);

		const promoted = await runAssistant(
			host,
			ctx,
			assistant([call("t3", "todo", { op: "init", list: [] })]),
		);
		expect(promoted[0].output.details.relay.canStop).toBe(true);
		expect(promoted[0].output.details.relay.handoffPending).toBe(false);

		const repeated = await runAssistant(
			host,
			ctx,
			assistant([call("t4", "todo", { op: "init", list: [] })]),
		);
		expect(repeated[0].output.details.relay.canStop).toBe(true);
		expect(repeated[0].output.details.relay.handoffPending).toBe(false);
	});

	test("after handoff, a stop before the successor evaluates nudges instead of handing off again", async () => {
		const { host, ctx, manager } = await start({ mode: "print" });
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		await runAssistant(host, ctx, assistant([{ type: "text", text: "Report 0" }]));
		const first = await emitStop(host, ctx);
		expect(first.continue).toBe(true);
		expect(countHandoffCompactions(manager)).toBe(1);
		expect(host.messages).toHaveLength(0);

		const second = await emitStop(host, ctx);
		expect(second.continue).toBe(true);
		expect(second.additionalContext).toContain("evaluate the ledger with todo");
		expect(countHandoffCompactions(manager)).toBe(1);
	});

	test("generation 1 first empty ledger promotes and does not nudge", async () => {
		const { host, ctx } = await start({ mode: "rpc" });
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		await runAssistant(host, ctx, assistant([{ type: "text", text: "Report 0" }]));
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
		const { host, ctx, manager, aborts } = await start({ mode: "rpc" });
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		await runAssistant(host, ctx, assistant([{ type: "text", text: "Report 0" }]));
		await emitStop(host, ctx);
		expect(countHandoffCompactions(manager)).toBe(1);

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
		expect(countHandoffCompactions(manager)).toBe(1);

		const laterEmpty = await runAssistant(
			host,
			ctx,
			assistant([call("t3", "todo", { op: "init", list: [] })]),
		);
		expect(laterEmpty[0].output.details.relay.canStop).toBe(false);
		await runAssistant(host, ctx, assistant([{ type: "text", text: "Report 1" }]));
		await emitStop(host, ctx);
		expect(countHandoffCompactions(manager)).toBe(2);
		const view = await runAssistant(
			host,
			ctx,
			assistant([call("t4", "todo", { op: "view" })]),
		);
		expect(view[0].output.details.relay.generation).toBe(2);
		expect(aborts.length).toBe(0);
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
			assistant([call("b1", "scope", { begin: { intent: "work", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "ro" } })]),
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
			assistant([call("b1", "scope", { begin: { intent: "early", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "ro" } })]),
		);
		expect(blocked[0].blocked).toBe(true);
		expect(blocked[0].result.content[0].text).toContain("RELAY_HANDOFF_PENDING");

		const fresh = await start({ mode: "rpc" });
		await runAssistant(
			fresh.host,
			fresh.ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		await runAssistant(fresh.host, fresh.ctx, assistant([{ type: "text", text: "Handoff summary" }]));
		const stop = await emitStop(fresh.host, fresh.ctx);
		expect(stop.continue).toBe(true);
		expect(countHandoffCompactions(fresh.manager)).toBe(1);
		const allowed = await runAssistant(
			fresh.host,
			fresh.ctx,
			assistant([call("b2", "scope", { begin: { intent: "audit", stage: "acceptance-cases", budget: { read: 1 }, elder_report: null, permission: "ro" } })]),
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
		const session = new Session(["read", "scope", "amend", "defer", "pin", "todo"]);
		await session.activateVibeTools(["read"]);
		expect(session.active).toEqual([
			"read",
			"scope",
			"amend",
			"defer",
			"pin",
			"todo",
			"task",
		]);
	});
});

describe("handoff integration", () => {
	function handoffSignal(manager) {
		return manager.entries.find(
			(entry) =>
				entry.type === "message" &&
				entry.message?.customType === "herd-relay-handoff",
		);
	}

	test("countHandoffCompactions counts only handoff methods", () => {
		const manager = makeManager();
		expect(countHandoffCompactions(null)).toBeNull();
		expect(countHandoffCompactions(manager)).toBe(0);
		manager.appendCompaction("handoff");
		manager.appendCompaction("soft");
		manager.appendCompaction(undefined, { method: "handoff" });
		expect(countHandoffCompactions(manager)).toBe(2);
	});

	test("self-handoff writes compaction boundary without sending extra user messages", async () => {
		const started = await start({ mode: "print" });
		const result = await runAssistant(
			started.host,
			started.ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		expect(result[0].output.content.at(-1).text).toContain("DO NOT call any more tools");
		await runAssistant(started.host, started.ctx, assistant([{ type: "text", text: "My handoff report" }]));
		const stop = await emitStop(started.host, started.ctx);
		expect(stop.continue).toBe(true);
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
		const begin = (model, elder_report = null) => ({ intent: "model check", stage: "direct-execution", budget: { read: 1 }, model, elder_report, permission: "ro" });
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

	test("a host-resolved role is not compared with a fuzzy model match", async () => {
		const { ctx, session, scope, begin } = await fixture();
		installBuiltinSlashExecutor(async (text, runtime) => {
			const match = /^\/switch\s+(.+)$/.exec(String(text).trim());
			if (!match) return false;
			const spec = match[1].trim();
			await runtime.ctx.onSwitchModel(spec === "task" ? "fixture/small" : spec);
			return true;
		});
		session.modelRegistry.getAll = () => [
			large,
			small,
			tiny,
			{ provider: "gateway", id: "lazy/task", contextWindow: 1_000_000 },
		];
		const result = await scope("role", { begin: begin("task") });
		const text = result.content.map((part) => part.text).join(" ");
		expect(text).not.toContain("WARNING:");
		expect(session.model).toBe(small);
		expect(stateFor(ctx).state.scopes.at(-1).modelKey).toBe("fixture/small");
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
				call("b1", "scope", { begin: { intent: "outer", stage: "direct-execution", budget: { read: 2 }, elder_report: null, permission: "ro" } }),
			]),
		);
		await runAssistant(
			started.host,
			started.ctx,
			assistant([
				call("b2", "scope", { begin: { intent: "inner", stage: "orchestration-plan", budget: { read: 2 }, elder_report: null, permission: "ro" } }),
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
	test("a refused system slash command never falls through to a conversation prompt", async () => {
		const { sendSlashPrompt } = await import("../src/host/index.mjs");
		const session = { prompt() { throw new Error("unexpected conversation prompt"); } };
		const command = "/handoff relay audit\nverify independently";
		const result = await sendSlashPrompt(session, command, {
			slashOnly: true,
			builtinExecutor: async (raw) => raw,
		});
		expect(result.handled).toBe(false);
		expect(result.residual).toBe(command);
	});

	test("the relay handoff does not call the slash dispatcher", async () => {
		const { host, ctx, manager } = await start({ mode: "rpc" });
		let slashCalls = 0;
		installBuiltinSlashExecutor(async () => {
			slashCalls += 1;
			return false;
		});
		await runAssistant(host, ctx, assistant([call("empty", "todo", { op: "init", list: [] })]));
		await runAssistant(host, ctx, assistant([{ type: "text", text: "Handoff report body" }]));
		await emitStop(host, ctx);
		expect(countHandoffCompactions(manager)).toBe(1);
		expect(slashCalls).toBe(0);
		expect(host.messages).toHaveLength(0);
	});

	test("the headless adapter has no compaction path", async () => {
		const { createHeadlessTuiContext } = await import("../src/host/index.mjs");
		const headless = createHeadlessTuiContext({});
		expect("runCommandInBackground" in headless.ctx).toBe(false);
		expect(() => headless.ctx.handleCompactCommand("x", "handoff")).toThrow(
			"Headless compaction is unavailable",
		);
		expect("completion" in headless).toBe(false);
	});
});

describe("handoff transaction recovery", () => {
	test("a pending station is not reused by a different session", async () => {
		const registry = createStationRegistry(null);
		const managerA = { getSessionId: () => "session-a" };
		const managerB = { getSessionId: () => "session-b" };
		const stationA = registry.stationFor({ sessionManager: managerA });
		const stationB = registry.stationFor({ sessionManager: managerB });
		stationA.state.relay = { ...stationA.state.relay, handoffPending: true };
		registry.markPending(stationA);

		expect(registry.stationForStop({ sessionManager: managerB })).toBe(stationB);
		expect(registry.stationForStop({ sessionManager: managerA })).toBe(stationA);
	});

	test("a successor can arm a second handoff at the generation it continued from", async () => {
		const { host, ctx, manager } = await start({ mode: "rpc" });

		await runAssistant(
			host,
			ctx,
			assistant([call("empty-1", "todo", { op: "init", list: [] })]),
		);
		await runAssistant(host, ctx, assistant([{ type: "text", text: "Report gen 0" }]));
		const firstStop = await emitStop(host, ctx);
		expect(firstStop.continue).toBe(true);
		expect(stateFor(ctx).state.relay.generation).toBe(1);
		expect(countHandoffCompactions(manager)).toBe(1);

		// The successor promotes on its first empty evaluation.
		await runAssistant(
			host,
			ctx,
			assistant([call("promote", "todo", { op: "init", list: [] })]),
		);
		expect(stateFor(ctx).state.relay.canStop).toBe(true);

		// A new user task invalidates the promotion and adds open work.
		await runAssistant(
			host,
			ctx,
			assistant([
				call("task", "todo", {
					op: "init",
					list: [{ phase: "P", items: ["new task"] }],
				}),
			]),
		);
		expect(stateFor(ctx).state.relay.canStop).toBe(false);

		// Completing that task arms the next handoff at generation 1.
		await runAssistant(
			host,
			ctx,
			assistant([call("empty-2", "todo", { op: "init", list: [] })]),
		);
		expect(stateFor(ctx).state.relay.handoffPending).toBe(true);
		await runAssistant(host, ctx, assistant([{ type: "text", text: "Report gen 1" }]));
		const secondStop = await emitStop(host, ctx);
		expect(secondStop.continue).toBe(true);
		expect(countHandoffCompactions(manager)).toBe(2);
		expect(stateFor(ctx).state.relay.generation).toBe(2);
		expect(host.messages).toHaveLength(0);
	});

	test("successor opening audit scopes before first todo still promotes and never sees predecessor elders or messages", async () => {
		const { host, ctx, manager, session } = await start({ mode: "print" });
		// Predecessor opens and closes an unarchived scope in generation 0.
		await runAssistant(
			host,
			ctx,
			assistant([call("b_pre", "scope", { begin: { intent: "predecessor work", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "ro" } })]),
		);
		await runAssistant(
			host,
			ctx,
			assistant([call("r_pre", "read", { path: "predecessor-secret.txt" })]),
		);
		await runAssistant(
			host,
			ctx,
			assistant([call("e_pre", "scope", { end: true })]),
		);
		await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);
		await runAssistant(host, ctx, assistant([{ type: "text", text: "Predecessor handoff report" }]));
		const handoffStop = await emitStop(host, ctx);
		expect(handoffStop.continue).toBe(true);
		expect(stateFor(ctx).state.relay.generation).toBe(1);
		expect(stateFor(ctx).state.epoch).toBe(1);
		expect(countHandoffCompactions(manager)).toBe(1);

		// Compaction boundary cuts off all predecessor messages from rebuilt context.
		const rebuilt = manager.buildSessionContext().messages;
		expect(rebuilt).toHaveLength(1);
		expect(rebuilt[0].role).toBe("compactionSummary");
		expect(rebuilt[0].content[0].text).toContain("Predecessor handoff report");
		expect(session.agent.state.messages).toHaveLength(1);

		// Successor opens an audit scope with elder_report: null — must NOT require predecessor's elder report.
		const auditBegin = await runAssistant(
			host,
			ctx,
			assistant([call("b_audit", "scope", { begin: { intent: "audit", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "ro" } })]),
		);
		expect(auditBegin[0].blocked).toBe(false);
		expect(auditBegin[0].result.isError).toBe(false);
		await runAssistant(
			host,
			ctx,
			assistant([call("e_audit", "scope", { end: true })]),
		);

		// Successor's first todo evaluation is empty -> promotes and allows stopping cleanly.
		const promoted = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "init", list: [] })]),
		);
		expect(promoted[0].output.details.relay.canStop).toBe(true);
		expect(promoted[0].output.details.relay.promotionInvalidated).toBe(false);
		expect(await emitStop(host, ctx)).toBeUndefined();
	});
});

describe("scope begin permission", () => {
	test("the schema requires permission ro|rw", () => {
		const begin = scopeParameters.properties.begin;
		expect(begin.required).toContain("permission");
		expect(begin.properties.permission.enum).toEqual(["ro", "rw"]);
	});

	test("permission ro opens before the first ledger submission", async () => {
		const { host, ctx } = await start();
		const [opened] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "inspect", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "ro" } }),
		]));
		expect(opened.result.isError).toBeFalsy();
		expect(opened.result.content[0].text).toContain("You are now inside this scope.");
		expect(stateFor(ctx).state.scopes).toHaveLength(1);
	});

	test("permission rw is refused before the first ledger submission", async () => {
		const { host, ctx } = await start();
		const [refused] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "write", stage: "direct-execution", budget: { edit: 1 }, elder_report: null, permission: "rw" } }),
		]));
		expect(refused.result.isError).toBe(true);
		expect(refused.result.content[0].text).toContain("RW_BEFORE_LEDGER");
		expect(stateFor(ctx).state.scopes).toHaveLength(0);
	});

	test("permission rw is refused in decision-framing even after a ledger exists", async () => {
		const { host, ctx } = await start();
		stateFor(ctx).state.relay.firstEvaluation = "nonempty";
		const [refused] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "frame", stage: "decision-framing", budget: { read: 1 }, elder_report: null, permission: "rw" } }),
		]));
		expect(refused.result.isError).toBe(true);
		expect(refused.result.content[0].text).toContain("RW_IN_DECISION_FRAMING");
		expect(stateFor(ctx).state.scopes).toHaveLength(0);
	});

	test("permission rw opens after the first ledger submission", async () => {
		const { host, ctx } = await start();
		await runAssistant(host, ctx, assistant([
			call("t1", "todo", { op: "init", list: [{ phase: "work", items: ["write the change"] }] }),
		]));
		expect(stateFor(ctx).state.relay.firstEvaluation).toBe("nonempty");
		const [opened] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "write", stage: "direct-execution", budget: { edit: 1 }, elder_report: null, permission: "rw" } }),
		]));
		expect(opened.result.isError).toBeFalsy();
		expect(stateFor(ctx).state.scopes).toHaveLength(1);
	});

	test("an invalid permission value is rejected", async () => {
		const { host, ctx } = await start();
		const [refused] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "work", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "write" } }),
		]));
		expect(refused.result.content[0].text).toContain("INVALID_ARGUMENT");
		expect(refused.result.content[0].text).toContain("permission");
		expect(stateFor(ctx).state.scopes).toHaveLength(0);
	});

	test("a todo view does not lift the rw gate", async () => {
		const { host, ctx } = await start();
		await runAssistant(host, ctx, assistant([
			call("t1", "todo", { op: "view" }),
		]));
		expect(stateFor(ctx).state.relay.firstEvaluation).toBeNull();
		const [refused] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "write", stage: "direct-execution", budget: { edit: 1 }, elder_report: null, permission: "rw" } }),
		]));
		expect(refused.result.content[0].text).toContain("RW_BEFORE_LEDGER");
		expect(stateFor(ctx).state.scopes).toHaveLength(0);
	});

	test("a handoff resets the rw gate for the successor", async () => {
		const { host, ctx } = await start();
		await runAssistant(host, ctx, assistant([
			call("t1", "todo", { op: "init", list: [{ phase: "work", items: ["ship it"] }] }),
		]));
		const station = stateFor(ctx);
		station.state.relay = beginGenerationAfterHandoff(station.state.relay, { fromGeneration: 0 });
		const [refused] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "audit", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "rw" } }),
		]));
		expect(refused.result.content[0].text).toContain("RW_BEFORE_LEDGER");
		expect(station.state.scopes).toHaveLength(0);
	});

	test("an omitted permission is treated as rw and refused before the first ledger", async () => {
		const { host, ctx } = await start();
		const [refused] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "write", stage: "direct-execution", budget: { edit: 1 }, elder_report: null } }),
		]));
		expect(refused.result.isError).toBe(true);
		expect(refused.result.content[0].text).toContain("RW_BEFORE_LEDGER");
		expect(stateFor(ctx).state.scopes).toHaveLength(0);
	});

	test("a null permission is treated like an omitted one", async () => {
		const { host, ctx } = await start();
		const [refused] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "write", stage: "direct-execution", budget: { edit: 1 }, elder_report: null, permission: null } }),
		]));
		expect(refused.result.isError).toBe(true);
		expect(refused.result.content[0].text).toContain("RW_BEFORE_LEDGER");
		expect(stateFor(ctx).state.scopes).toHaveLength(0);
	});

	test("an omitted permission is refused in decision-framing even after a ledger exists", async () => {
		const { host, ctx } = await start();
		stateFor(ctx).state.relay.firstEvaluation = "nonempty";
		const [refused] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "frame", stage: "decision-framing", budget: { read: 1 }, elder_report: null } }),
		]));
		expect(refused.result.isError).toBe(true);
		expect(refused.result.content[0].text).toContain("RW_IN_DECISION_FRAMING");
		expect(stateFor(ctx).state.scopes).toHaveLength(0);
	});

	test("an omitted permission opens after the first ledger submission", async () => {
		const { host, ctx } = await start();
		await runAssistant(host, ctx, assistant([
			call("t1", "todo", { op: "init", list: [{ phase: "work", items: ["write the change"] }] }),
		]));
		const [opened] = await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "write", stage: "direct-execution", budget: { edit: 1 }, elder_report: null } }),
		]));
		expect(opened.result.isError).toBeFalsy();
		expect(stateFor(ctx).state.scopes).toHaveLength(1);
	});
});

describe("free resolution write", () => {
	test("a write to xd://resolve needs no write budget", async () => {
		const { host, ctx } = await start();
		await runAssistant(host, ctx, assistant([
			call("b1", "scope", { begin: { intent: "work", stage: "direct-execution", budget: { read: 1 }, elder_report: null, permission: "ro" } }),
		]));
		const [resolved] = await runAssistant(host, ctx, assistant([
			call("w1", "write", { path: "xd://resolve", content: "apply" }),
		]));
		expect(resolved.blocked).toBe(false);
		const [real] = await runAssistant(host, ctx, assistant([
			call("w2", "write", { path: "src/out.txt", content: "x" }),
		]));
		expect(real.blocked).toBe(true);
		expect(real.result.content[0].text).toContain("no budget left");
	});
});
