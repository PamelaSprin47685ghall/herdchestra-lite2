/**
 * Fake-host integration: exercises the real hooks and tool executes against a
 * session manager with the same tree semantics as omp.
 */

import { describe, expect, test } from "bun:test";
import { activate } from "../host-omp/src/main.mjs";
import { CHILD_ACTIVITY_TYPE } from "../host-omp/src/host/child-display.mjs";
import { skillReceiptText } from "../src/station/texts.mjs";
import { installVibeTools } from "../host-omp/src/host/index.mjs";
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
