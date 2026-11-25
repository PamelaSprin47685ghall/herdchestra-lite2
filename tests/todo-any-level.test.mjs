/**
 * todo at every branch level, and skill reads in a child that holds turns.
 *
 * The consumer is the model and the host: every assertion reads a tool result
 * or the relay state. The ledger itself stays the host's native todo; this
 * suite proves only the seam this extension owns — the root write evaluates
 * the relay, a fork child's write is free and never touches it, and a
 * skill:// read is free wherever it runs.
 */

import { describe, expect, test } from "bun:test";
import { activate } from "../host-omp/src/main.mjs";
import {
	createBracketLedger,
	markReady,
	registerFork,
	takeReady,
} from "../src/scope/index.mjs";
import { appendRequestMessages, attachRequestPreparation } from "./helpers/request-preparation.mjs";

// The live station comes from the registry that `start()` just built. A
// module-wide accessor keeps the test bodies focused on relay behavior.
let activeStation = null;
function stateFor() {
	if (!activeStation) throw new Error("start() has not run");
	return activeStation;
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

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
			}
			return {
				content: [{ type: "text", text: `todo ${op}` }],
				details: { op, phases: clone(phases), storage: "memory" },
			};
		},
	};
}

async function start() {
	const manager = makeManager();
	const host = makeHost();
	const native = makeNativeTodo();
	host.tools.set("todo", {
		name: "todo",
		execute: async () => ({ content: [{ type: "text", text: "host builtin" }] }),
	});
	const wired = await activate(host.pi, {});
	const ctx = {
		sessionManager: manager,
		mode: "rpc",
		invokeTool: (params) => native.execute(params),
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
	activeStation = wired.engine.station(ctx);
	// Every case in this file exercises the relay; manual duty has its own
	// cases at the end and flips the flag off explicitly.
	activeStation.state.autopilot = true;
	return { host, ctx, native, session, station: activeStation };
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

function relayOf(ctx) {
	return stateFor(ctx).state.relay;
}

function textOf(result) {
	return result.result.content.map((part) => part.text ?? "").join("");
}

describe("todo on the root branch", () => {
	test("evaluates the ledger and reports the relay state", async () => {
		const { host, ctx } = await start();
		const [written] = await runAssistant(
			host,
			ctx,
			assistant([
				call("t1", "todo", {
					op: "init",
					list: [{ phase: "P", items: ["root work"] }],
				}),
			]),
		);

		expect(written.blocked).toBe(false);
		expect(relayOf(ctx).firstEvaluation).toBe("nonempty");
		expect(relayOf(ctx).lastLedger.open).toBe(1);
		expect(relayOf(ctx).handoffPending).toBe(false);
		expect(textOf(written)).toContain("RELAY STATE");
	});

	test("is allowed while an unreceived child result is outstanding, but an empty ledger is held", async () => {
		const { host, ctx, station } = await start();
		const registered = registerFork(station.forkLedgerPort(), {
			forkId: "fork_open",
			ownerId: "root",
			levelKey: "root|0|0",
			fsm: "unreceived child",
			depth: 0,
		});
		expect(registered.ok).toBe(true);
		const [written] = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);

		expect(written.blocked).toBe(false);
		expect(relayOf(ctx).firstEvaluation).toBeNull();
		expect(relayOf(ctx).handoffPending).toBe(false);
		expect(relayOf(ctx).lastLedger).toBeNull();
		expect(textOf(written)).toContain("RELAY STATE");
		expect(textOf(written)).toContain("unreceived result(s) from forked scopes");
	});
});

describe("todo in a fork child", () => {
	test("writes the ledger for free and leaves the relay untouched", async () => {
		const { host, ctx, station } = await start();
		const ledger = asChild(station);
		const before = JSON.stringify(stateFor(ctx).state.relay);
		const [written] = await runAssistant(
			host,
			ctx,
			assistant([
				call("t1", "todo", {
					op: "init",
					list: [{ phase: "P", items: ["child work"] }],
				}),
			]),
		);

		expect(written.blocked).toBe(false);
		expect(written.result.isError).toBeFalsy();
		expect(written.output.details.phases[0].tasks[0].content).toBe("child work");
		expect(JSON.stringify(stateFor(ctx).state.relay)).toBe(before);
		expect(textOf(written)).not.toContain("RELAY STATE");
		expect(textOf(written)).toContain("did not advance");
		expect(ledger.forks.fork_a.remaining).toEqual(ledger.forks.fork_a.budget);
	});

	test("an empty child ledger does not arm a handoff", async () => {
		const { host, ctx, station } = await start();
		asChild(station);
		const [emptied] = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "init", list: [] })]),
		);

		expect(emptied.blocked).toBe(false);
		expect(relayOf(ctx).handoffPending).toBe(false);
		expect(relayOf(ctx).generation).toBe(0);
		expect(relayOf(ctx).firstEvaluation).toBeNull();
		expect(relayOf(ctx).canStop).toBe(false);
		expect(relayOf(ctx).lastLedger).toBeNull();
		expect(textOf(emptied)).not.toContain("RELAY STATE");
	});

	test("stays available while the child itself owns an unreceived grandchild", async () => {
		const { host, ctx, station } = await start();
		const ledger = asChild(station);
		const grandchild = registerFork(ledger, {
			forkId: "grand",
			ownerId: "fork_a",
			levelKey: "fork_a|0|0",
			fsm: "grandchild work",
			depth: 1,
		});
		expect(grandchild.ok).toBe(true);
		const [written] = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "view" })]),
		);

		expect(written.blocked).toBe(false);
		expect(written.result.isError).toBeFalsy();
	});

	test("a deep view leaves the inherited-ledger debt for the root", async () => {
		const { host, ctx, station } = await start();
		stateFor(ctx).state.relay = {
			...stateFor(ctx).state.relay,
			viewRequired: true,
		};
		const ledger = asChild(station);
		const [deep] = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "view" })]),
		);
		expect(deep.blocked).toBe(false);
		expect(relayOf(ctx).viewRequired).toBe(true);

		// The root may evaluate the ledger only after the child result is
		// received; that is the ordinary join sequence, not a test shortcut.
		expect(markReady(ledger, "fork_a", { ok: true }).ok).toBe(true);
		expect(takeReady(ledger, { ownerId: "root" }).ok).toBe(true);
		asRoot(station);
		const [outer] = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "init", list: [] })]),
		);
		expect(outer.result.isError).toBe(true);
		expect(textOf(outer)).toContain("INHERITED_LEDGER_UNVIEWED");
	});

	test("is refused on the root while a handoff is pending", async () => {
		const { host, ctx } = await start();
		stateFor(ctx).state.relay = {
			...stateFor(ctx).state.relay,
			handoffPending: true,
		};
		const [root] = await runAssistant(
			host,
			ctx,
			assistant([call("t1", "todo", { op: "view" })]),
		);
		expect(root.blocked).toBe(true);
		expect(textOf(root)).toContain("RELAY_HANDOFF_PENDING");
	});

	test("is not refused in a child while the root handoff is pending", async () => {
		const { host, ctx, station } = await start();
		stateFor(ctx).state.relay = {
			...stateFor(ctx).state.relay,
			handoffPending: true,
		};
		asChild(station);
		const [child] = await runAssistant(
			host,
			ctx,
			assistant([call("t2", "todo", { op: "view" })]),
		);
		expect(child.blocked).toBe(false);
		expect(textOf(child)).not.toContain("RELAY_HANDOFF_PENDING");
	});
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
		// The refusal is a turn decision, not a relay evaluation.
		expect(relayOf(ctx).firstEvaluation).toBe(null);
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

	test("is refused on the root during a pending handoff", async () => {
		const { host, ctx } = await start();
		stateFor(ctx).state.relay = {
			...stateFor(ctx).state.relay,
			handoffPending: true,
		};
		const [refused] = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", SKILL_READ)]),
		);
		expect(refused.blocked).toBe(true);
		expect(textOf(refused)).toContain("RELAY_HANDOFF_PENDING");
	});

	test("is allowed in a child during a pending root handoff", async () => {
		const { host, ctx, station } = await start();
		stateFor(ctx).state.relay = {
			...stateFor(ctx).state.relay,
			handoffPending: true,
		};
		asChild(station);
		const [read] = await runAssistant(
			host,
			ctx,
			assistant([call("r1", "read", SKILL_READ)]),
		);
		expect(read.blocked).toBe(false);
		expect(textOf(read)).not.toContain("RELAY_HANDOFF_PENDING");
	});
});

describe("todo description", () => {
	test("says free at every level and never forbidden", async () => {
		const { host } = await start();
		const definition = host.tools.get("todo");
		expect(definition.description).toMatch(/free at every level/i);
		expect(definition.description).not.toContain("forbidden inside any active scope");
	});
});

describe("manual duty (autopilot off)", () => {
	test("a todo write leaves the relay untouched and hides RELAY STATE", async () => {
		const { host, ctx } = await start();
		stateFor(ctx).state.autopilot = false;
		const before = JSON.stringify(stateFor(ctx).state.relay);
		const [written] = await runAssistant(
			host,
			ctx,
			assistant([call("m1", "todo", { op: "init", list: [] })]),
		);

		expect(written.blocked).toBe(false);
		expect(written.result.isError).toBeFalsy();
		expect(JSON.stringify(stateFor(ctx).state.relay)).toBe(before);
		expect(textOf(written)).not.toContain("RELAY STATE");
		expect(textOf(written)).not.toContain("handoff report");
	});

	test("ask is allowed, and the native todo still runs", async () => {
		const { host, ctx } = await start();
		stateFor(ctx).state.autopilot = false;
		const [asked] = await runAssistant(
			host,
			ctx,
			assistant([call("m2", "ask", { question: "Which file?" })]),
		);
		expect(asked.blocked).toBe(false);
	});

	test("a natural stop neither arms a handoff nor demands a report", async () => {
		const { host, ctx, station } = await start();
		stateFor(ctx).state.autopilot = false;
		const stop = await emit(
			host.handlers,
			"session_stop",
			{ last_assistant_message: { stopReason: "stop" } },
			ctx,
		);
		expect(stop).toBeUndefined();
		expect(stateFor(ctx).state.relay.handoffPending).toBe(false);
		expect(station.state.relay.firstEvaluation).toBeNull();
	});

	test("a stale relay handoff cannot block tools in manual duty", async () => {
		const { host, ctx } = await start();
		stateFor(ctx).state.autopilot = false;
		stateFor(ctx).state.relay = {
			...stateFor(ctx).state.relay,
			handoffPending: true,
		};
		const [written] = await runAssistant(
			host,
			ctx,
			assistant([call("m4", "todo", { op: "view" })]),
		);
		const [asked] = await runAssistant(
			host,
			ctx,
			assistant([call("m5", "ask", { question: "Paused?" })]),
		);

		expect(written.blocked).toBe(false);
		expect(textOf(written)).not.toContain("RELAY_HANDOFF_PENDING");
		expect(asked.blocked).toBe(false);
	});

	test("turning autopilot on restores relay evaluation and the relay prompt", async () => {
		const { host, ctx, session, station } = await start();
		stateFor(ctx).state.autopilot = false;

		const toggled = station.onAutopilotCommand("");
		expect(toggled).toEqual({ ok: true, mode: "on", text: "" });

		const [emptied] = await runAssistant(
			host,
			ctx,
			assistant([call("m3", "todo", { op: "init", list: [] })]),
		);
		expect(emptied.blocked).toBe(false);
		expect(relayOf(ctx).handoffPending).toBe(true);
		expect(textOf(emptied)).toContain("handoff report");

		const source = session.agent.state.systemPrompt;
		const sourceText = Array.isArray(source) ? source.join("\n") : source ?? "";
		const prepared = await emit(
			host.handlers,
			"before_agent_start",
			{ systemPrompt: source },
			ctx,
		);
		// The managed block is the same bytes in both modes, so the gate leaves
		// an inherited prompt untouched and the relay text was already there.
		expect(prepared).toBeUndefined();
		expect(sourceText).toContain("Any successful `todo` write");
	});
});

describe("ask under autopilot", () => {
	test("is blocked for the root and for a child", async () => {
		const { host, ctx, station } = await start();
		stateFor(ctx).state.autopilot = true;

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
		stateFor(ctx).state.autopilot = false;
		asChild(station);

		const [child] = await runAssistant(
			host,
			ctx,
			assistant([call("a3", "ask", { question: "Which file?" })]),
		);
		expect(child.blocked).toBe(false);
	});
});
