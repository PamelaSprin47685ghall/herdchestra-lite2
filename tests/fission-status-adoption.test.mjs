import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
	createFissionScheduler,
} from "../src/host/fission-scheduler.mjs";
import { createFissionManager } from "../src/host/fission-manager.mjs";
import { createStatusRuntime } from "../src/host/index.mjs";
import {
	beginScope,
	createState,
	splitFissionBudget,
} from "../src/scope/index.mjs";

const LEVEL_TEMPLATE = readFileSync(
	new URL("../resources/prompts/receipts/scope.md", import.meta.url),
	"utf8",
);

// -- Status aggregation -----------------------------------------------------

function makeStatusUi() {
	const widgets = new Map();
	const widgetWrites = [];
	return {
		widgets,
		widgetWrites,
		setWidget(key, content, options) {
			widgetWrites.push({ key, content, options });
			widgets.set(key, { content, options });
		},
	};
}

function makeStatusHost() {
	const handlers = new Map();
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
	};
	return { pi, handlers };
}

function emit(handlers, event, payload, ctx) {
	for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
}

function usage(input, output = 0, cost = 0) {
	return { input_tokens: input, output_tokens: output, total_cost: cost };
}

function herdLine(ui) {
	return ui.widgets.get("herd").content[0];
}

// The minimum manager contract a real flow proxy needs: one global leaf, the
// journal as truth, and a session name for the prefix segment.
function sharedJournal(name = "Herd 2A: shared") {
	const entries = [];
	let leaf = null;
	let next = 0;
	const find = (id) => entries.find((entry) => entry.id === id);
	const append = (fields) => {
		const entry = { id: `e${(next += 1).toString(16).padStart(4, "0")}`, parentId: leaf, ...fields };
		entries.push(entry);
		leaf = entry.id;
		return entry.id;
	};
	return {
		entries,
		getLeafId: () => leaf,
		getEntry: (id) => find(id),
		getEntries: () => entries.slice(),
		getBranch: (fromId) => {
			let current = fromId === undefined ? leaf : fromId;
			const branch = [];
			while (current != null) {
				const entry = find(current);
				if (!entry) throw new Error(`missing entry ${current}`);
				branch.unshift(entry);
				current = entry.parentId;
			}
			return branch;
		},
		branch: (id) => {
			if (!find(id)) throw new Error(`Entry ${id} not found`);
			leaf = id;
		},
		resetLeaf: () => {
			leaf = null;
		},
		appendMessage: (message) => append({ type: "message", message }),
		appendCustomEntry: (customType, data) => append({ type: "custom", customType, data }),
		getSessionName: () => name,
		seal: () => {},
		close: () => Promise.resolve(),
	};
}

describe("fission status aggregation", () => {
	test("two flows over one manager add totals and leave the delta to the newest writer", () => {
		const { pi, handlers } = makeStatusHost();
		createStatusRuntime().install(pi);
		const ui = makeStatusUi();
		const shared = sharedJournal();
		const first = createFissionManager(shared, { flowId: "flow-a", label: "b1.0" });
		const second = createFissionManager(shared, { flowId: "flow-b", label: "b1.1" });
		const firstCtx = { hasUI: true, ui, sessionManager: first, agent: { id: "flow-a" } };
		const secondCtx = { hasUI: true, ui, sessionManager: second, agent: { id: "flow-b" } };

		emit(handlers, "session_start", {}, firstCtx);
		emit(
			handlers,
			"message_end",
			{ message: { role: "assistant", usage: usage(1000, 200, 0.1) } },
			firstCtx,
		);
		emit(
			handlers,
			"message_end",
			{ message: { role: "assistant", usage: usage(500, 100, 0.05) } },
			secondCtx,
		);

		const line = herdLine(ui);
		// One record for the session: the delta is the second flow's request,
		// the sigma is both requests, not one flow's private ledger.
		expect(line).toContain("Δ: 0.5k × 0.0% → 0.1k [¥𝟬.𝟬𝟱𝟬];");
		expect(line).toContain("Σ: 1.5k × 0.0% → 0.3k [¥𝟬.𝟭𝟱𝟬];");
	});

	test("a raw manager and a sub-shaped flow still resolve the flow proxy", () => {
		const { pi, handlers } = makeStatusHost();
		createStatusRuntime().install(pi);
		const ui = makeStatusUi();
		const shared = sharedJournal();
		createFissionManager(shared, { flowId: "flow-a", label: "b1.0" });
		// The host may expose only its raw manager; the flow carries the marks a
		// subagent would carry, but the proxy proves it is a peer.
		const ctx = {
			hasUI: true,
			ui,
			sessionManager: shared,
			agent: { id: "flow-a", kind: "sub", depth: 1, parentAgentId: "Main" },
		};

		emit(handlers, "session_start", {}, ctx);
		emit(
			handlers,
			"message_end",
			{ message: { role: "assistant", usage: usage(700, 70, 0.07) } },
			ctx,
		);

		expect(ui.widgetWrites.length).toBeGreaterThan(0);
		expect(herdLine(ui)).toContain("Δ: 0.7k × 0.0% → 0.1k [¥𝟬.𝟬𝟳𝟬];");
	});

	test("a raw manager with only the flow label resolves the same record", () => {
		const { pi, handlers } = makeStatusHost();
		createStatusRuntime().install(pi);
		const ui = makeStatusUi();
		const shared = sharedJournal();
		createFissionManager(shared, { flowId: "flow-a", label: "b1.0" });
		const second = createFissionManager(shared, { flowId: "flow-b", label: "b1.1" });
		const labelled = {
			hasUI: true,
			ui,
			sessionManager: shared,
			agent: { label: "b1.0" },
		};
		const direct = { hasUI: true, ui, sessionManager: second, agent: { id: "flow-b" } };

		emit(handlers, "session_start", {}, labelled);
		emit(
			handlers,
			"message_end",
			{ message: { role: "assistant", usage: usage(400, 40, 0.04) } },
			labelled,
		);
		emit(
			handlers,
			"message_end",
			{ message: { role: "assistant", usage: usage(600, 60, 0.06) } },
			direct,
		);

		const line = herdLine(ui);
		expect(line).toContain("Δ: 0.6k × 0.0% → 0.1k [¥𝟬.𝟬𝟲𝟬];");
		expect(line).toContain("Σ: 1.0k × 0.0% → 0.1k [¥𝟬.𝟭𝟬𝟬];");
	});

	test("a UI-less flow writes its usage through the session's display host", () => {
		const { pi, handlers } = makeStatusHost();
		createStatusRuntime().install(pi);
		const ui = makeStatusUi();
		const shared = sharedJournal();
		const first = createFissionManager(shared, { flowId: "flow-a", label: "b1.0" });
		const mainCtx = { hasUI: true, ui, sessionManager: shared };
		emit(handlers, "session_start", {}, mainCtx);
		const before = ui.widgetWrites.length;

		const flowCtx = {
			hasUI: false,
			ui,
			sessionManager: first,
			agent: { id: "flow-a", kind: "sub", depth: 1 },
		};
		emit(
			handlers,
			"message_end",
			{ message: { role: "assistant", usage: usage(900, 90, 0.09) } },
			flowCtx,
		);

		expect(ui.widgetWrites.length).toBeGreaterThan(before);
		expect(herdLine(ui)).toContain("Δ: 0.9k × 0.0% → 0.1k [¥𝟬.𝟬𝟵𝟬];");
	});
});

// -- Async model adoption --------------------------------------------------
//
// The scheduler test double mirrors the host facts adoption depends on: one
// global leaf, off-branch copies that never move it, and an owner session whose
// setModel() may settle later (or reject) than the flow that triggers it.

function makeJournal() {
	const entries = [];
	const calls = { atomic: 0 };
	let leaf = null;
	let next = 0;
	const id = () => `e${(next += 1).toString(16).padStart(6, "0")}`;
	const find = (value) => entries.find((entry) => entry.id === value);
	const appendHere = (fields) => {
		const entry = { id: id(), parentId: leaf, ...fields };
		entries.push(entry);
		leaf = entry.id;
		return entry.id;
	};
	return {
		entries,
		calls,
		getSessionFile: () => "/virtual/fission-session.jsonl",
		getEntries: () => entries.slice(),
		getEntry: (value) => find(value) ?? null,
		getLeafId: () => leaf,
		getBranch: (from) => {
			let current = from === undefined ? leaf : from;
			const branch = [];
			for (let guard = 0; current != null && guard < 10000; guard += 1) {
				const entry = find(current);
				if (!entry) throw new Error(`missing entry ${current}`);
				branch.unshift(entry);
				current = entry.parentId;
			}
			return branch;
		},
		branch: (value) => {
			if (!find(value)) throw new Error(`Entry ${value} not found`);
			leaf = value;
		},
		resetLeaf: () => {
			leaf = null;
		},
		appendMessage: (message) => appendHere({ type: "message", message }),
		appendCustomEntry: (customType, data) => appendHere({ type: "custom", customType, data }),
		appendEntriesAtomically: async (write) => {
			calls.atomic += 1;
			const snapshot = entries.slice();
			const savedLeaf = leaf;
			try {
				return await write();
			} catch (error) {
				entries.splice(0, entries.length, ...snapshot);
				leaf = savedLeaf;
				throw error;
			}
		},
		ingestReplicatedEntry: (entry) => {
			entries.push({ ...entry });
			leaf = entry.id;
			return entry.id;
		},
	};
}

function makeAgent(id) {
	const agent = {
		id,
		steered: [],
		steering: [],
		followUpQueue: [],
		liveSteered: [],
		withdrawn: 0,
		cleared: 0,
		aborted: false,
		state: { messages: [], isStreaming: false },
		reset() {
			agent.state.messages.length = 0;
			agent.steering = [];
			agent.followUpQueue = [];
			agent.liveSteered = [];
		},
		abort(reason) {
			agent.aborted = true;
			agent.abortReason = reason;
			if (agent.liveSteered.length > 0) {
				agent.steering = [...agent.liveSteered, ...agent.steering];
				agent.liveSteered = [];
			}
		},
		steer(message) {
			agent.steered.push(message);
			agent.steering.push(message);
		},
		followUp(message) {
			agent.followUpQueue.push(message);
		},
		clearSteeringQueue() {
			agent.cleared += 1;
			agent.steering = [];
		},
		clearFollowUpQueue() {
			agent.cleared += 1;
			agent.followUpQueue = [];
		},
		peekSteeringQueue() {
			return agent.steering.slice();
		},
		peekFollowUpQueue() {
			return agent.followUpQueue.slice();
		},
		peekUndeliveredQueuedMessages() {
			return agent.liveSteered.slice();
		},
		withdrawUndeliveredQueuedMessages() {
			agent.withdrawn += 1;
			return { steering: agent.liveSteered.splice(0), followUp: [] };
		},
		replaceQueue(queue, messages) {
			if (queue === "steering") agent.steering = messages.slice();
			else agent.followUpQueue = messages.slice();
		},
	};
	return agent;
}

function makeFlowSession(plan) {
	const agent = makeAgent(plan.flowId);
	const listeners = [];
	const session = {
		agent,
		model: plan.model,
		prompts: [],
		settleCalls: 0,
		onSettle: null,
		finish: null,
		getAgentId: () => plan.flowId,
		setModel(model) {
			session.model = model;
		},
		async settleInFlightMessagePersistence() {
			session.settleCalls += 1;
			if (session.onSettle) await session.onSettle();
		},
		subscribe(listener) {
			listeners.push(listener);
			return () => {};
		},
		prompt(message) {
			if (typeof message !== "string") {
				throw new TypeError("message.startsWith is not a function");
			}
			session.prompts.push(message);
			return new Promise((resolve, reject) => {
				session.finish = { resolve, reject };
			});
		},
	};
	return session;
}

function harness({ fission, budget = { read: 10, bash: 4 } }) {
	const manager = makeJournal();
	const state = createState();
	const parent = beginScope(state, {
		intent: "owner",
		stage: "architecture-design",
		budget,
	}).scope;
	const ownerAgent = makeAgent("owner");
	const ownerSession = {
		agent: ownerAgent,
		model: { id: "owner-model" },
		settleCalls: 0,
		modelSwitches: [],
		async settleInFlightMessagePersistence() {
			ownerSession.settleCalls += 1;
		},
		setModel(model) {
			ownerSession.model = model;
			ownerSession.modelSwitches.push(model);
		},
	};
	const bindings = [];
	const spawned = [];
	const bridge = {
		attached: [],
		attach(flowId) {
			bridge.attached.push(flowId);
			return () => {};
		},
		accept() {},
		dispose() {},
	};
	const ref = {};
	const station = {
		state,
		manager,
		registry: { fissionScheduler: () => ref.scheduler },
		policy: () => "main",
		relayOn: () => false,
	};
	const scheduler = createFissionScheduler({
		manager,
		session: ownerSession,
		agent: ownerAgent,
		levelTemplate: LEVEL_TEMPLATE,
		vibeActive: false,
		bridge,
		resolveModel: (spec) => (typeof spec === "string" ? { id: spec } : spec),
		bindFlow(flowId, flowStation, permission, meta) {
			bindings.push({ flowId, station: flowStation, permission, meta });
		},
		unbindFlow() {},
		async spawnFlow(plan) {
			const session = makeFlowSession(plan);
			spawned.push({ plan, session });
			return { session };
		},
	});
	ref.scheduler = scheduler;
	const begin = { stage: "architecture-design", elder_report: null, fission };
	const totals = {};
	for (const item of fission) {
		for (const [tool, amount] of Object.entries(item.budget)) {
			totals[tool] = (totals[tool] ?? 0) + amount;
		}
	}
	return {
		manager,
		state,
		parent,
		ownerAgent,
		ownerSession,
		station,
		scheduler,
		bindings,
		spawned,
		begin,
		totals,
	};
}

function register(h, toolCallId) {
	return h.scheduler.registerBatch({
		toolCallId,
		sessionManager: h.manager,
		station: h.station,
		ctx: { agent: { id: "owner" } },
		begin: h.begin,
		flows: h.begin.fission,
		totals: h.totals,
		stage: h.begin.stage,
		mainAgent: true,
	});
}

function reserve(h) {
	return splitFissionBudget(h.state, h.begin, { mainAgent: true, relayOn: false });
}

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition never became true");
}

async function startBatch(h, toolCallId) {
	const registered = register(h, toolCallId);
	expect(reserve(h).ok).toBe(true);
	h.manager.appendMessage({ role: "toolResult", toolCallId, content: "registered" });
	const started = await h.scheduler.onOwnerEnd({ batch: registered.batch });
	expect(started.ok).toBe(true);
	return registered;
}

/** Run the first flow to completion so the second receives its segment. */
async function closeFirstFlow(h, registered) {
	const [first] = h.scheduler.listFlows();
	const firstSession = h.spawned[0].session;
	h.scheduler.requestFlowEnd(first.flowId);
	firstSession.finish.resolve();
	await h.scheduler.flowEnded(first.flowId);
	await waitFor(() => h.scheduler.batchStatus(registered.batchId).handoffs.length === 0);
	return { first, firstSession };
}

function heirFlows() {
	return [
		{ intent: "first", budget: { read: 3, bash: 1 }, permission: "ro" },
		{ intent: "second", budget: { read: 2, bash: 1 }, permission: "rw", model: "heir-model" },
	];
}

function sameModelFlows() {
	return [
		{ intent: "first", budget: { read: 3, bash: 1 }, permission: "ro" },
		{ intent: "second", budget: { read: 2, bash: 1 }, permission: "rw" },
	];
}

async function endHeir(h, second, secondSession) {
	h.scheduler.requestFlowEnd(second.flowId);
	secondSession.finish.resolve();
	return h.scheduler.flowEnded(second.flowId);
}

describe("fission async model adoption", () => {
	test("waits for setModel() to settle before moving the owner leaf", async () => {
		const h = harness({ fission: heirFlows() });
		const registered = await startBatch(h, "call-adopt-order");
		await closeFirstFlow(h, registered);
		const [, second] = h.scheduler.listFlows();
		const secondSession = h.spawned[1].session;

		const applied = [];
		let releaseSwitch = null;
		let switchStarted = false;
		const branchAfterSwitch = [];
		const originalBranch = h.manager.branch.bind(h.manager);
		h.manager.branch = (id) => {
			if (switchStarted) branchAfterSwitch.push({ resolved: applied.length > 0, id });
			return originalBranch(id);
		};
		h.ownerSession.setModel = (model) =>
			new Promise((resolve) => {
				switchStarted = true;
				releaseSwitch = () => {
					applied.push(model);
					h.ownerSession.model = model;
					resolve();
				};
			});

		// Not awaited: the switch is deliberately pending, so awaiting the
		// flow's finish promise here would wait forever.
		const ending = endHeir(h, second, secondSession);
		await waitFor(() => typeof releaseSwitch === "function");

		// The context splice is synchronous and happens before the await; the
		// switch has not landed yet, so the session still reports its old model.
		expect(h.ownerAgent.state.messages).toEqual(secondSession.agent.state.messages);
		expect(h.ownerSession.model).toEqual({ id: "owner-model" });
		expect(applied).toHaveLength(0);
		expect(branchAfterSwitch).toHaveLength(0);
		expect(h.scheduler.batchStatus(registered.batchId).status).toBe("finalizing");

		releaseSwitch();
		await ending;
		const done = await h.scheduler.waitForBatch(registered.batchId);

		expect(applied).toEqual([{ id: "heir-model" }]);
		expect(h.ownerSession.model).toEqual({ id: "heir-model" });
		expect(branchAfterSwitch.length).toBeGreaterThan(0);
		expect(branchAfterSwitch.every((call) => call.resolved)).toBe(true);
		expect(done.status).toBe("closed");
		expect(done.outcome).toBe("closed");
		expect(done.heir).toBe(second.label);
	});

	test("reports a rejected setModel() as an adoption failure after adopting the context", async () => {
		const h = harness({ fission: heirFlows() });
		const registered = await startBatch(h, "call-adopt-reject");
		await closeFirstFlow(h, registered);
		const [, second] = h.scheduler.listFlows();
		const secondSession = h.spawned[1].session;
		h.ownerSession.setModel = async () => {
			throw new Error("provider refused the switch");
		};

		await endHeir(h, second, secondSession);
		const done = await h.scheduler.waitForBatch(registered.batchId);

		// The context and the leaf still belong to the heir; only the model
		// identity failed, and the batch says so instead of claiming a clean
		// succession.
		expect(done.status).toBe("failed");
		expect(done.outcome).toBe("closed-with-adoption-failure");
		expect(done.limits).toContain("OWNER_MODEL_NOT_SWITCHED");
		expect(h.ownerAgent.state.messages).toEqual(secondSession.agent.state.messages);
		const tip = h.manager.getBranch().at(-1);
		expect(tip.customType).toBe("scope.end");
		expect(tip.data.batchId).toBe(registered.batchId);
	});

	test("does not report a failure when no setModel() exists but both sides share the model", async () => {
		const h = harness({ fission: sameModelFlows() });
		const registered = await startBatch(h, "call-adopt-same-model");
		await closeFirstFlow(h, registered);
		const [, second] = h.scheduler.listFlows();
		const secondSession = h.spawned[1].session;
		delete h.ownerSession.setModel;

		await endHeir(h, second, secondSession);
		const done = await h.scheduler.waitForBatch(registered.batchId);

		expect(secondSession.model).toBe(h.ownerSession.model);
		expect(done.status).toBe("closed");
		expect(done.outcome).toBe("closed");
		expect(done.limits).toEqual([]);
		expect(h.ownerAgent.state.messages).toEqual(secondSession.agent.state.messages);
	});
});
