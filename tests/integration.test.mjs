/**
 * Fake-host integration: exercises the real hooks and tool executes against a
 * session manager with the same tree semantics as omp.
 */

import { describe, expect, test } from "bun:test";
import { activate } from "../host-omp/src/main.mjs";
import { CHILD_ACTIVITY_TYPE } from "../host-omp/src/host/child-display.mjs";
import { installVibeTools } from "../host-omp/src/host/capture.mjs";
import { appendRequestMessages, attachRequestPreparation } from "./helpers/request-preparation.mjs";
import { buildTickets } from "../host-omp/src/activation/tickets.mjs";
import { createHostBag } from "../host-omp/src/activation/index.mjs";
import { wireHooks } from "../host-omp/src/activation/hooks.mjs";

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
	host.pi.tui = {
		jsx: (kind, props) => ({ kind, text: props.text, props: () => props }),
	};
	const renderers = new Map();
	host.pi.registerMessageRenderer = (type, render) => {
		renderers.set(type, render);
		if (type === "fission.broadcast") renderer = render;
	};
	await activate(host.pi);
	const message = { content: "(broadcast to 2 flows)\n\noperator note" };
	expect(renderers.get(CHILD_ACTIVITY_TYPE)).not.toBeUndefined();
	expect(renderer(message).props().text).toBe(message.content);
	expect(renderer({ content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }).props().text).toBe("first\nsecond");
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
describe("root rewind host lifecycle", () => {
	function bindRewind() {
		const manager = {
			...makeManager(),
			getSessionId: () => "test-session",
			appendCompaction() {},
		};
		const host = makeHost();
		const ctx = { sessionManager: manager };
		const events = [];
		const queue = ["operator steer"];
		const plan = { startPrompt: "Continue from the compacted report." };
		let paused = 0;
		let settle;
		const persistence = new Promise((resolve) => { settle = resolve; });
		const session = {
			sessionManager: manager,
			transcriptEpoch: 0,
			agent: { abort: (reason) => events.push(reason) },
			async withQueueDrainPaused(callback) {
				paused += 1;
				try {
					await callback();
				} finally {
					paused -= 1;
				}
			},
			async waitForIdle() {
				events.push("idle");
			},
			settleInFlightMessagePersistence() {
				events.push("persistence");
				return persistence;
			},
			async prompt(text, options) {
				events.push({ text, paused, synthetic: options.synthetic, attribution: options.attribution });
				options.onPromptAdmitted();
				return queue.shift();
			},
		};
		attachRequestPreparation(session, ctx);
		const tickets = buildTickets(host.pi);
		const capabilities = createHostBag(host.pi);
		let ticket;
		const station = {
			manager,
			prepareRequest() {
				return null;
			},
			onAgentEnd(endedCtx, event) {
				expect(endedCtx).toBe(ctx);
				if (event.willContinue !== true || event.awaitingAsyncWork === true) {
					ticket = tickets.rewindRoot(this, endedCtx, plan);
				}
			},
			commitRootRewind(endedCtx, pending) {
				expect(endedCtx).toBe(ctx);
				expect(pending).toBe(plan);
				expect(paused).toBe(1);
				events.push("commit");
				return true;
			},
			abortRootRewind(pending) {
				expect(pending).toBe(plan);
				events.push("stale");
			},
		};
		wireHooks(host.pi, { station: () => station });
		return {
			host, ctx, session, plan, events, queue, capabilities, settle,
			paused: () => paused,
			ticket: () => ticket,
			async terminalReturn() {
				await session.agent.afterToolCall({
					toolCall: { name: "scope_return" },
					result: { details: { stopLoop: true, scope: "root", rewind: true } },
				}, AbortSignal.abort("tool interrupted by steer"));
			},
		};
	}

	test("hands the queue hold from the terminal tool result to the detached rewind ticket", async () => {
		const { host, ctx, session, plan, events, queue, capabilities, settle, paused, ticket, terminalReturn } = bindRewind();
		expect(capabilities.session.canRewindRoot(ctx)).toBe(false);
		await emit(host.handlers, "session_start", {}, ctx);
		const stop = session.agent.afterToolCall;
		await emit(host.handlers, "session_start", {}, ctx);
		expect(session.agent.afterToolCall).toBe(stop);
		expect(capabilities.session.canRewindRoot(ctx)).toBe(true);
		await terminalReturn();
		expect(paused()).toBe(1);

		await emit(host.handlers, "agent_end", { messages: [] }, ctx);
		expect(events).toEqual([Symbol.for("pi-agent-core.terminal-tool-result"), "idle", "persistence"]);
		expect(paused()).toBe(1);
		expect(queue).toEqual(["operator steer"]);
		settle();
		await ticket();
		expect(queue).toEqual([]);
		expect(events.slice(-2)).toEqual([
			"commit",
			{ text: plan.startPrompt, paused: 1, synthetic: true, attribution: "agent" },
		]);
		expect(paused()).toBe(0);
	});

	test("rejects a replaced transcript after waiting and releases the queue", async () => {
		const { host, ctx, session, events, settle, paused, ticket, terminalReturn } = bindRewind();
		await emit(host.handlers, "session_start", {}, ctx);
		await terminalReturn();
		await emit(host.handlers, "agent_end", { messages: [] }, ctx);
		session.transcriptEpoch += 1;
		settle();
		await ticket();
		expect(events).toEqual([Symbol.for("pi-agent-core.terminal-tool-result"), "idle", "persistence", "stale"]);
		expect(paused()).toBe(0);
	});

	test("holds the host run active across root rewind until agent_start and surfaces takeover failure", async () => {
		const jobs = new Map();
		const acknowledged = [];
		let nextJob = 0;
		const listeners = new Set();
		const externalEvents = [];
		const { host, ctx, session, events, settle, paused, ticket, terminalReturn } = bindRewind();
		session.getAgentId = () => "main-agent";
		session.asyncJobManager = {
			register(_type, _label, executor, options) {
				const id = `job-${++nextJob}`;
				const entry = { id, status: "running", ownerId: options?.ownerId, promise: null };
				entry.promise = Promise.resolve().then(() => executor({ jobId: id })).then(() => {
					entry.status = "completed";
				});
				jobs.set(id, entry);
				return id;
			},
			acknowledgeDeliveries(ids) {
				acknowledged.push(...ids);
			},
		};
		session.subscribe = (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		};
		session.agent.emitExternalEvent = (event) => {
			externalEvents.push(event);
			if (event.type === "message_end") session.agent.state.messages.push(event.message);
		};
		const originalPrompt = session.prompt;
		session.prompt = async (text, options) => {
			const res = await originalPrompt(text, options);
			for (const listener of [...listeners]) listener({ type: "agent_start" });
			return res;
		};

		await emit(host.handlers, "session_start", {}, ctx);
		await terminalReturn();
		expect(jobs.size).toBe(1);
		expect(jobs.get("job-1").status).toBe("running");
		expect(jobs.get("job-1").ownerId).toBe("main-agent");

		// Host pauses with awaitingAsyncWork because the run-hold job is active.
		await emit(host.handlers, "agent_end", { messages: [], willContinue: true, awaitingAsyncWork: true }, ctx);
		expect(jobs.get("job-1").status).toBe("running");
		settle();
		await ticket();
		await jobs.get("job-1").promise;
		expect(acknowledged).toEqual(["job-1"]);
		expect(jobs.get("job-1").status).toBe("completed");
		expect(paused()).toBe(0);
		expect(externalEvents).toEqual([]);

		// Takeover failure: resume prompt drops -> error assistant emitted before run hold releases.
		session.prompt = async () => {
			throw new Error("prompt dropped");
		};
		await terminalReturn();
		expect(jobs.get("job-2").status).toBe("running");
		await emit(host.handlers, "agent_end", { messages: [], willContinue: true, awaitingAsyncWork: true }, ctx);
		await ticket();
		await jobs.get("job-2").promise;
		expect(acknowledged).toEqual(["job-1", "job-2"]);
		expect(externalEvents.map((entry) => entry.type)).toEqual(["message_start", "message_end"]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "Root rewind takeover failed: prompt dropped",
		});
		expect(events.slice(-2)).toEqual(["commit", "persistence"]);
	});
});

describe("vibe mode", () => {
	test("keeps the session's registered tools when entering vibe mode", async () => {
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
		// `amend`/`pin` are retired: whatever a session registered is kept, and
		// a retired name is not resurrected by entering vibe mode.
		const session = new Session(["read", "js", "amend", "pin"]);
		await session.activateVibeTools(["read", "js"]);
		expect(session.active).toEqual(["read", "js", "task"]);
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
		const rendered = view
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: (message.content ?? [])
							.map((block) => block.text ?? block.thinking ?? "")
							.join(""),
			)
			.join("\n");
		expect(rendered).toContain("direct as many parallel slice/swarm workers as causality allows");
		expect(view.some((message) => message.content === "drive two worker CLIs")).toBe(false);
	});
});
