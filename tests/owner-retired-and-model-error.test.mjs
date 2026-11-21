import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { wireHooks } from "../src/activation/hooks.mjs";
import { createFissionScheduler } from "../src/host/fission-scheduler.mjs";
import {
	beginScope,
	createState,
	splitFissionBudget,
} from "../src/scope/index.mjs";

const LEVEL_TEMPLATE = readFileSync(
	new URL("../resources/prompts/receipts/scope.md", import.meta.url),
	"utf8",
);

function fakePi() {
	const handlers = new Map();
	return {
		handlers,
		on(event, handler) {
			handlers.set(event, handler);
		},
	};
}

function makeHookStation({ pendingFission = null, ownerRetired = null } = {}) {
	const cleared = [];
	let beforeStartCalls = 0;
	let sessionStopCalls = 0;
	const station = {
		fissionFlow: false,
		pendingFission,
		ownerRetired,
		cleared,
		get beforeStartCalls() {
			return beforeStartCalls;
		},
		get sessionStopCalls() {
			return sessionStopCalls;
		},
		clearOwnerRetired(batchId) {
			cleared.push(batchId);
			if (station.ownerRetired?.batchId === batchId) {
				station.ownerRetired = null;
			}
		},
		ownerRetirement() {
			return station.ownerRetired;
		},
		onAssistantMessage() {},
		onMessageEnd() {},
		onUsageMessage() {},
		onToolCall() {},
		onContext() {},
		onBeforeAgentStart() {
			beforeStartCalls += 1;
			return "before-start-ok";
		},
		onSessionStop() {
			sessionStopCalls += 1;
			return "session-stop-ok";
		},
		onSessionSwitch() {},
		onSessionCompact() {},
	};
	return station;
}

describe("OWNER_RETIRED stale cleanup in hooks", () => {
	test("before_agent_start clears pendingFission and ownerRetired when batch is no longer running", () => {
		const batch = { batchId: "batch-closed" };
		const station = makeHookStation({
			pendingFission: batch,
			ownerRetired: { batchId: "batch-closed" },
		});
		const pi = fakePi();
		wireHooks(pi, {
			stationFor: () => station,
			stationForStop: () => station,
			fissionScheduler: () => ({
				batchStatus: (id) => (id === "batch-closed" ? { status: "closed" } : null),
			}),
		});

		const result = pi.handlers.get("before_agent_start")({}, {});
		expect(result).toBe("before-start-ok");
		expect(station.pendingFission).toBeNull();
		expect(station.ownerRetired).toBeNull();
		expect(station.cleared).toEqual(["batch-closed"]);
		expect(station.beforeStartCalls).toBe(1);
	});

	test("before_agent_start clears stale ownerRetired when pendingFission is already null", () => {
		const station = makeHookStation({
			pendingFission: null,
			ownerRetired: { batchId: "batch-stale" },
		});
		const pi = fakePi();
		wireHooks(pi, {
			stationFor: () => station,
			stationForStop: () => station,
			fissionScheduler: () => ({
				batchStatus: () => null,
			}),
		});

		const result = pi.handlers.get("before_agent_start")({}, {});
		expect(result).toBe("before-start-ok");
		expect(station.ownerRetired).toBeNull();
		expect(station.cleared).toEqual(["batch-stale"]);
	});

	test("before_agent_start preserves pendingFission and ownerRetired while batch is still running", () => {
		const batch = { batchId: "batch-live" };
		const station = makeHookStation({
			pendingFission: batch,
			ownerRetired: { batchId: "batch-live" },
		});
		const pi = fakePi();
		wireHooks(pi, {
			stationFor: () => station,
			stationForStop: () => station,
			fissionScheduler: () => ({
				batchStatus: () => ({ status: "running" }),
			}),
		});

		pi.handlers.get("before_agent_start")({}, {});
		expect(station.pendingFission).toBe(batch);
		expect(station.ownerRetired).toEqual({ batchId: "batch-live" });
		expect(station.cleared).toEqual([]);
	});

	test("session_stop clears stale pendingFission and ownerRetired and falls through to onSessionStop", () => {
		const batch = { batchId: "batch-ended" };
		const station = makeHookStation({
			pendingFission: batch,
			ownerRetired: { batchId: "batch-ended" },
		});
		const pi = fakePi();
		wireHooks(pi, {
			stationFor: () => station,
			stationForStop: () => station,
			fissionScheduler: () => ({
				batchStatus: () => ({ status: "closed" }),
			}),
		});

		const result = pi.handlers.get("session_stop")({}, {});
		expect(result).toBe("session-stop-ok");
		expect(station.pendingFission).toBeNull();
		expect(station.ownerRetired).toBeNull();
		expect(station.cleared).toEqual(["batch-ended"]);
		expect(station.sessionStopCalls).toBe(1);
	});

	test("session_stop keeps ownerRetired and returns undefined while batch is still running", () => {
		const batch = { batchId: "batch-active" };
		const station = makeHookStation({
			pendingFission: batch,
			ownerRetired: { batchId: "batch-active" },
		});
		const pi = fakePi();
		wireHooks(pi, {
			stationFor: () => station,
			stationForStop: () => station,
			fissionScheduler: () => ({
				batchStatus: () => ({ status: "running" }),
			}),
		});

		const result = pi.handlers.get("session_stop")({}, {});
		expect(result).toBeUndefined();
		expect(station.pendingFission).toBe(batch);
		expect(station.ownerRetired).toEqual({ batchId: "batch-active" });
		expect(station.cleared).toEqual([]);
		expect(station.sessionStopCalls).toBe(0);
	});
});

function makeJournal() {
	const entries = [];
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
		getSessionFile: () => "/virtual/model-error-test.jsonl",
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
		state: { messages: [], isStreaming: false },
		reset() {
			agent.state.messages.length = 0;
			agent.steering = [];
			agent.followUpQueue = [];
		},
		abort() {},
		steer(message) {
			agent.steered.push(message);
			agent.steering.push(message);
		},
		followUp(message) {
			agent.followUpQueue.push(message);
		},
		clearSteeringQueue() {
			agent.steering = [];
		},
		drainSteering() {
			const drained = agent.steering.splice(0);
			agent.state.messages.push(...drained);
			return drained;
		},
	};
	return agent;
}

function makeFlowSession(plan) {
	const agent = makeAgent(plan.flowId);
	const session = {
		agent,
		model: plan.model,
		complete: null,
		getAgentId: () => plan.flowId,
		setModel(model) {
			session.model = model;
		},
		async settleInFlightMessagePersistence() {},
		subscribe() {
			return () => {};
		},
		prompt() {
			return new Promise((resolve) => {
				session.complete = resolve;
			});
		},
	};
	agent.continue = () => {
		agent.drainSteering();
		return new Promise((resolve) => {
			session.complete = resolve;
		});
	};
	return session;
}

async function waitFor(predicate, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for condition");
}

async function startSingleFlow(toolCallId) {
	const manager = makeJournal();
	const state = createState();
	beginScope(state, {
		intent: "owner",
		stage: "architecture-design",
		budget: { read: 10, bash: 4 },
		time: 60,
	});
	const ownerAgent = makeAgent("owner");
	const ownerSession = {
		agent: ownerAgent,
		model: { id: "owner-model" },
		async settleInFlightMessagePersistence() {},
		setModel(model) {
			ownerSession.model = model;
		},
	};
	const bridge = {
		attach() {
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
	let session;
	const scheduler = createFissionScheduler({
		manager,
		session: ownerSession,
		agent: ownerAgent,
		levelTemplate: LEVEL_TEMPLATE,
		vibeActive: false,
		bridge,
		bindFlow() {},
		unbindFlow() {},
		async spawnFlow(plan) {
			session = makeFlowSession(plan);
			return { session };
		},
	});
	ref.scheduler = scheduler;

	const fission = [
		{
			label: "worker",
			intent: "run work",
			permission: "ro",
			budget: { read: 4, bash: 2 },
			time: 30,
		},
	];
	const begin = { stage: "architecture-design", elder_report: null, time: 60, fission };
	const totals = { read: 4, bash: 2 };
	const registered = scheduler.registerBatch({
		toolCallId,
		sessionManager: manager,
		station,
		ctx: { agent: { id: "owner" } },
		begin,
		flows: fission,
		totals,
		stage: begin.stage,
		mainAgent: true,
	});
	expect(splitFissionBudget(state, begin, { mainAgent: true, relayOn: false }).ok).toBe(true);
	manager.appendMessage({ role: "toolResult", toolCallId, content: "registered" });
	await scheduler.onOwnerEnd({ batch: registered.batch });
	await waitFor(() => typeof session?.complete === "function");
	return { scheduler, session, batchId: registered.batchId };
}

describe("model recoverable error handling in fission-scheduler", () => {
	test("steers back to the model on upstream tool-choice error instead of crashing the flow", async () => {
		const { scheduler, session, batchId } = await startSingleFlow("call-tool-choice");

		const firstComplete = session.complete;
		session.agent.state.messages.push({
			role: "assistant",
			stopReason: "error",
			errorMessage: 'upstream called function "scope" outside the tool choice (upstream_error)',
			content: [],
		});
		firstComplete();

		await waitFor(() => session.complete !== firstComplete);
		expect(session.agent.steered).toHaveLength(1);
		expect(session.agent.steered[0].role).toBe("developer");
		expect(session.agent.steered[0].content[0].text).toContain(
			'upstream called function "scope" outside the tool choice (upstream_error)',
		);
		expect(scheduler.hasLiveBatches()).toBe(true);

		scheduler.requestFlowEnd(session.agent.id);
		session.complete();
		const settled = await scheduler.waitForBatch(batchId);
		expect(settled.status).toBe("closed");
	});

	test("steers back to the model on schema validation error", async () => {
		const { scheduler, session, batchId } = await startSingleFlow("call-schema-err");

		const firstComplete = session.complete;
		session.agent.state.messages.push({
			role: "assistant",
			stopReason: "error",
			errorMessage: "tool schema validation failed: missing required field",
			content: [],
		});
		firstComplete();

		await waitFor(() => session.complete !== firstComplete);
		expect(session.agent.steered).toHaveLength(1);
		expect(session.agent.steered[0].content[0].text).toContain("schema validation failed");

		scheduler.requestFlowEnd(session.agent.id);
		session.complete();
		const settled = await scheduler.waitForBatch(batchId);
		expect(settled.status).toBe("closed");
	});

	test("stops recovering after the retry cap (3) and settles the flow with error", async () => {
		const { scheduler, session, batchId } = await startSingleFlow("call-retry-cap");

		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const prev = session.complete;
			session.agent.state.messages.push({
				role: "assistant",
				stopReason: "error",
				errorMessage: 'upstream called function "scope" outside the tool choice (upstream_error)',
				content: [],
			});
			prev();
			await waitFor(() => session.complete !== prev);
		}
		expect(session.agent.steered).toHaveLength(3);

		// 4th consecutive recoverable error exceeds MODEL_ERROR_MAX_RETRIES (3).
		session.agent.state.messages.push({
			role: "assistant",
			stopReason: "error",
			errorMessage: 'upstream called function "scope" outside the tool choice (upstream_error)',
			content: [],
		});
		session.complete();

		const settled = await scheduler.waitForBatch(batchId);
		expect(session.agent.steered).toHaveLength(3);
		expect(String(settled.flows[0].error?.message ?? settled.flows[0].error)).toContain(
			"outside the tool choice",
		);
	});

	test("resets recoverable error retry counter after a clean stop turn", async () => {
		const { scheduler, session, batchId } = await startSingleFlow("call-retry-reset");

		// Hit 2 recoverable errors.
		for (let i = 0; i < 2; i += 1) {
			const prev = session.complete;
			session.agent.state.messages.push({
				role: "assistant",
				stopReason: "error",
				errorMessage: "invalid arguments for tool call",
				content: [],
			});
			prev();
			await waitFor(() => session.complete !== prev);
		}
		expect(session.agent.steered).toHaveLength(2);

		// Clean stop resets modelErrorRetries to 0 (and nudges once).
		const beforeStop = session.complete;
		session.agent.state.messages.push({
			role: "assistant",
			stopReason: "stop",
			content: [],
		});
		beforeStop();
		await waitFor(() => session.complete !== beforeStop);
		expect(session.agent.steered).toHaveLength(3);

		// Can now recover 3 more times before hitting the cap.
		for (let i = 0; i < 3; i += 1) {
			const prev = session.complete;
			session.agent.state.messages.push({
				role: "assistant",
				stopReason: "error",
				errorMessage: "invalid arguments for tool call",
				content: [],
			});
			prev();
			await waitFor(() => session.complete !== prev);
		}
		expect(session.agent.steered).toHaveLength(6);

		scheduler.requestFlowEnd(session.agent.id);
		session.complete();
		const settled = await scheduler.waitForBatch(batchId);
		expect(settled.status).toBe("closed");
	});
});
