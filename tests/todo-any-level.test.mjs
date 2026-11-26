// Native todo and skill reads stay free at every scope level.

import { describe, expect, test } from "bun:test";
import { activate } from "../host-omp/src/main.mjs";
import {
	createBracketLedger,
	registerFork,
} from "../src/scope/index.mjs";
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
	const steers = [];
	const messages = [];
	const activeTools = ["read", "write", "bash", "edit", "glob", "todo"];
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

function assistant(content) {
	return { role: "assistant", content, timestamp: Date.now() };
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

async function start() {
	const manager = makeManager();
	const host = makeHost();
	const nativeTodo = {
		name: "todo",
		execute: async (_id, { op, list }) => ({
			content: [{ type: "text", text: "host builtin" }],
			details: { op, phases: list },
		}),
	};
	host.tools.set("todo", nativeTodo);
	const wired = await activate(host.pi, {});
	const ctx = {
		sessionManager: manager,
		mode: "rpc",
	};
	const session = {
		sessionManager: manager,
		agent: {
			state: { messages: [], systemPrompt: [], tools: [...host.tools.values()] },
			beforeToolCall({ toolCall, args }) {
				return emit(host.handlers, "tool_call", {
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args,
				}, ctx);
			},
		},
	};
	attachRequestPreparation(session, ctx);
	const user = { role: "user", content: "do the task", timestamp: Date.now() };
	manager.appendMessage(user);
	appendRequestMessages(ctx, user);
	const prepared = await emit(
		host.handlers,
		"before_agent_start",
		{ systemPrompt: session.agent.state.systemPrompt },
		ctx,
	);
	if (prepared?.systemPrompt) session.agent.state.systemPrompt = prepared.systemPrompt;
	const station = wired.engine.station(ctx);
	station.state.autopilot = true;
	return { host, ctx, nativeTodo, station };
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
			manager.appendMessage(result);
			appendRequestMessages(ctx, result);
			results.push({ result, blocked: true });
			continue;
		}
		const tool = host.tools.get(block.name);
		const output = tool
			? await tool.execute(block.id, block.arguments, undefined, undefined, ctx)
			: { content: [{ type: "text", text: `${block.name} ok` }] };
		const text = (output.content ?? []).map((part) => part.text ?? "").join("");
		const result = toolResult(block.id, block.name, text, Boolean(output.isError), output.details);
		manager.appendMessage(result);
		appendRequestMessages(ctx, result);
		results.push({ result, blocked: false, output });
	}
	return results;
}

/**
 * Make this station behave as one fork child. The test owns the root side of
 * the ledger, so a child record is registered exactly as scope_fork would.
 */
function asChild(station, { forkId = "fork_a", budget = { read: 1 }, time = 60 } = {}) {
	const ledger = createBracketLedger();
	const registered = registerFork(ledger, {
		forkId,
		ownerId: "root",
		levelKey: "root|0|0",
		fsm: "child work",
		depth: 0,
		budget,
		time,
	});
	expect(registered.ok).toBe(true);
	station.forkLedgerPort = () => ledger;
	station.forkOwnerId = () => forkId;
	station.ownerId = forkId;
	station.forkDepthPort = () => 1;
	return ledger;
}

function asRoot(station) {
	station.forkOwnerId = () => null;
	station.ownerId = null;
	station.forkDepthPort = () => 0;
}

function textOf(result) {
	return result.result.content.map((part) => part.text ?? "").join("");
}

describe("native todo", () => {
	for (const level of ["root", "child"]) {
		test(`uses the unwrapped host tool at the ${level} without spending a turn`, async () => {
			const { host, ctx, nativeTodo, station } = await start();
			const ledger = level === "child" ? asChild(station, { budget: { todo: 1 } }) : null;
			const list = [{ phase: "Plan", items: ["native item"] }];
			const [written] = await runAssistant(
				host,
				ctx,
				assistant([call("todo1", "todo", { op: "init", list })]),
			);

			expect(host.tools.get("todo")).toBe(nativeTodo);
			expect(written.blocked).toBe(false);
			expect(textOf(written)).toBe("host builtin");
			expect(written.output.details).toEqual({ op: "init", phases: list });
			if (ledger) expect(ledger.forks.fork_a.remaining.todo).toBe(1);
		});
	}
});

const SKILL_READ = { path: "skill://tdd-crowdsource", i: "reading the contract skill" };

describe("skill read at every level", () => {
	test("an ordinary read on the root branch is refused because the root has no turns", async () => {
		const { host, ctx, station } = await start();
		asRoot(station);
		const [read] = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "notes.txt" })]),
		);
		expect(read.blocked).toBe(true);
		expect(textOf(read)).toContain("no ordinary tool budget");
		expect(textOf(read)).toContain("scope_fork");
	});

	test("is allowed on the root branch", async () => {
		const { host, ctx } = await start();
		const [read] = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", SKILL_READ)]),
		);
		expect(read.blocked).toBe(false);
		expect(read.result.isError).toBeFalsy();
	});

	test("is free in a child that holds turns", async () => {
		const { host, ctx, station } = await start();
		const ledger = asChild(station, { budget: { read: 1 } });
		const [read] = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", SKILL_READ)]),
		);
		expect(read.blocked).toBe(false);
		expect(ledger.forks.fork_a.remaining.read).toBe(1);
	});

	test("an ordinary path still spends the child's read budget", async () => {
		const { host, ctx, station } = await start();
		const ledger = asChild(station, { budget: { read: 1 } });
		const [read] = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", { path: "notes.txt" })]),
		);
		expect(read.blocked).toBe(false);
		expect(ledger.forks.fork_a.remaining.read).toBe(0);
	});

});

test("manual duty allows a natural stop", async () => {
	const { host, ctx, station } = await start();
	station.state.autopilot = false;
	const stop = await emit(
		host.handlers,
		"session_stop",
		{ last_assistant_message: { stopReason: "stop" } },
		ctx,
	);
	expect(stop).toBeUndefined();
});

describe("ask under autopilot", () => {
	test("is blocked for the root and for a child", async () => {
		const { host, ctx, station } = await start();
		const [root] = await runAssistant(
			host,
			ctx,
			assistant([call("a1", "ask", { question: "Which file?" })]),
		);
		expect(root.blocked).toBe(true);
		expect(textOf(root)).toContain("Autopilot is on");

		asChild(station);
		const [child] = await runAssistant(
			host,
			ctx,
			assistant([call("a2", "ask", { question: "Which file?" })]),
		);
		expect(child.blocked).toBe(true);
		expect(textOf(child)).toContain("Autopilot is on");
	});

	test("stays available to a child in manual duty", async () => {
		const { host, ctx, station } = await start();
		station.state.autopilot = false;
		asChild(station);

		const [child] = await runAssistant(
			host,
			ctx,
			assistant([call("a3", "ask", { question: "Which file?" })]),
		);
		expect(child.blocked).toBe(false);
	});
});
