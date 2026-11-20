import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
	FISSION_SCHEDULER_CODES,
	createFissionScheduler,
} from "../src/host/fission-scheduler.mjs";
import {
	beginScope,
	createState,
	currentScope,
	splitFissionBudget,
} from "../src/scope/index.mjs";

const LEVEL_TEMPLATE = readFileSync(
	new URL("../resources/prompts/receipts/scope.md", import.meta.url),
	"utf8",
);

// A journal that behaves like the host facts the scheduler reads: one shared
// leaf, branch-derived parents, off-leaf rolls back atomically, and replicated
// entries keep their assigned ids.
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
		aborted: false,
		state: { messages: [], isStreaming: false },
		reset() {
			agent.state.messages.length = 0;
		},
		abort() {
			agent.aborted = true;
		},
		steer(message) {
			agent.steered.push(message);
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
			// The real AgentSession.prompt() treats its argument as text and
			// calls string methods on it. Fail exactly as the host does when a
			// non-string arrives, so this stub is a regression, not a mock.
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

function harness({ fission, budget = { read: 10, bash: 4 }, hooks = {} }) {
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
		bindFlow(flowId, flowStation, permission, meta) {
			bindings.push({ flowId, station: flowStation, permission, meta });
			hooks.bindFlow?.(flowId, flowStation, permission, meta);
		},
		unbindFlow(flowId) {
			hooks.unbindFlow?.(flowId);
		},
		async spawnFlow(plan) {
			if (hooks.spawnFlow) return hooks.spawnFlow(plan);
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

// The control handler reserves after registration. This helper mirrors that one
// call, so a second debit anywhere in the scheduler is visible as extra spend.
function reserve(h) {
	return splitFissionBudget(h.state, h.begin, { mainAgent: true, relayOn: false });
}

function totalsOf(flows) {
	const totals = {};
	for (const item of flows) {
		for (const [tool, amount] of Object.entries(item.budget)) {
			totals[tool] = (totals[tool] ?? 0) + amount;
		}
	}
	return totals;
}

// Mirror the control path for a nested batch: the owning flow registers with
// its own station and identity, reserves on its own state, and the host commits
// the toolResult under the batch boundary before agent_end starts the flows.
async function startNested(h, { toolCallId, parentFlowId, fission }) {
	const binding = h.bindings.find((item) => item.flowId === parentFlowId);
	if (!binding) throw new Error(`no station bound for ${parentFlowId}`);
	const begin = { stage: "architecture-design", elder_report: null, fission };
	const registered = h.scheduler.registerBatch({
		toolCallId,
		sessionManager: h.manager,
		station: binding.station,
		ctx: { agent: { id: parentFlowId } },
		identity: { id: parentFlowId },
		begin,
		flows: fission,
		totals: totalsOf(fission),
		stage: begin.stage,
		mainAgent: true,
		nested: true,
	});
	const split = splitFissionBudget(binding.station.state, begin, {
		mainAgent: true,
		relayOn: false,
	});
	expect(split.ok).toBe(true);
	h.manager.appendMessage({ role: "toolResult", toolCallId, content: "registered" });
	const outcome = await h.scheduler.onOwnerEnd({ batch: registered.batch });
	expect(outcome.ok).toBe(true);
	return registered;
}

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition never became true");
}

function twoFlows() {
	return [
		{ intent: "first", budget: { read: 3, bash: 1 }, permission: "ro" },
		{ intent: "second", budget: { read: 2, bash: 1 }, permission: "rw" },
	];
}

describe("fission scheduler", () => {
	test("registration charges nothing; the control reservation is the only debit", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-a");
		expect(registered.ok).toBe(true);
		expect(h.parent.remaining).toEqual({ read: 10, bash: 4 });

		const split = reserve(h);
		expect(split.ok).toBe(true);
		expect(h.parent.remaining).toEqual({ read: 5, bash: 2 });

		// The receipt is appended by the host at the leaf registration left.
		const ackId = h.manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-a",
			content: "registered",
		});
		expect(h.manager.getEntry(ackId).parentId).toBe(registered.batchBeginId);

		// controls.mjs installs this descriptor when it registers the batch.
		h.station.pendingFission = { batchId: registered.batchId, retired: true };
		const started = h.scheduler.onOwnerEnd({ batch: registered.batch });
		expect(started).toBeInstanceOf(Promise);
		await started;
		// The control station's pending descriptor is released only after every
		// flow started; the host hook cannot await onOwnerEnd to do it.
		expect(h.station.pendingFission).toBeNull();

		// The batch scope holds the allocation but is not charged a second time.
		const batchScope = currentScope(h.state);
		expect(batchScope.budget).toEqual({ read: 5, bash: 2 });
		expect(batchScope.remaining).toEqual({ read: 5, bash: 2 });
		expect(h.parent.remaining).toEqual({ read: 5, bash: 2 });

		expect(h.spawned).toHaveLength(2);
		expect(h.bindings).toHaveLength(2);
		expect(h.bindings[0].station).not.toBe(h.bindings[1].station);
		expect(h.bindings[0].station.state).not.toBe(h.state);
		expect(h.bindings.map((binding) => binding.permission)).toEqual(["ro", "rw"]);

		const flows = h.scheduler.listFlows();
		expect(flows.map((flow) => flow.status)).toEqual(["running", "running"]);
		for (const flow of flows) {
			expect(h.manager.getEntry(flow.beginId).parentId).toBe(ackId);
		}
		expect(h.bindings[0].station.state.scopes.at(-1).intent).toBe("first");
		expect(h.bindings[1].station.state.scopes.at(-1).intent).toBe("second");
		for (const { session } of h.spawned) {
			expect(session.agent.state.messages.length).toBeGreaterThan(0);
		}

		// Finish in sequence: the first segment is copied to the second flow
		// while it is still running. Unordered ends are covered by the handoff
		// case, which waits on the journal before resolving the next turn.
		h.spawned[0].session.finish.resolve();
		await h.scheduler.flowEnded(h.scheduler.listFlows()[0].flowId);
		// A handoff record leaves the queue only after its segment is committed
		// and its messages are injected. Waiting on `handoff.end` alone would
		// observe the journal a microtask before injection, when the target's
		// model context does not yet contain the copied turn.
		await waitFor(() => h.scheduler.batchStatus(registered.batchId).handoffs.length === 0);
		h.spawned[1].session.finish.resolve();
		await h.scheduler.flowEnded(h.scheduler.listFlows()[1].flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("closed");
	});

	test("copies a closed flow to the next running flow and adopts the heir", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-b");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-b", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });

		const [first, second] = h.scheduler.listFlows();
		const firstSession = h.spawned[0].session;
		const secondSession = h.spawned[1].session;

		// The turn promise settles before the host has persisted the last
		// assistant message. Writing it inside the settle hook proves the
		// scheduler reads the tail only after persistence is idle.
		firstSession.onSettle = () => {
			h.manager.branch(first.beginId);
			h.manager.appendMessage({
				role: "assistant",
				content: "You are inside scope level 1: first.",
				timestamp: 2,
			});
		};
		firstSession.finish.resolve();
		await h.scheduler.flowEnded(first.flowId);
		// The journal records `handoff.end` before copyRecord injects the
		// messages; the record leaves the queue only after both. Wait for the
		// queue so the assertion below reads the target's post-injection state.
		await waitFor(() => h.scheduler.batchStatus(registered.batchId).handoffs.length === 0);
		expect(firstSession.settleCalls).toBe(1);

		// The copied segment becomes the second flow's next context, with the
		// scope-level number shifted by the depth of its new position.
		const injected = secondSession.agent.state.messages;
		expect(injected.some((message) =>
			typeof message.content === "string" &&
			message.content.includes("You are inside scope level 3: first."),
		)).toBe(true);
		const entries = h.manager.getEntries();
		expect(entries.some((entry) => entry.customType === "fission.handoff.begin")).toBe(true);
		expect(entries.some((entry) => entry.customType === "fission.handoff.end")).toBe(true);

		secondSession.finish.resolve();
		await h.scheduler.flowEnded(second.flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);

		expect(done.status).toBe("closed");
		expect(done.heir).toBe(second.label);
		expect(done.flows.map((flow) => flow.status)).toEqual(["closed", "closed"]);
		// Adoption moves the heir's context into the owner agent, not a copy
		// of the owner's old context.
		expect(h.ownerAgent.state.messages).toEqual(secondSession.agent.state.messages);
		expect(h.ownerAgent.state.messages).toHaveLength(injected.length);
		// The active leaf is the batch boundary, not the last flow write.
		const tip = h.manager.getBranch().at(-1);
		expect(tip.customType).toBe("scope.end");
		expect(tip.data.batchId).toBe(registered.batchId);
		expect(h.manager.getBranch().some((entry) =>
			entry.customType === "fission.handoff.begin",
		)).toBe(true);
	});

	test("refuses an unaffordable batch before any journal or budget change", () => {
		const h = harness({ fission: twoFlows(), budget: { read: 1, bash: 1 } });
		let error;
		try {
			register(h, "call-c");
		} catch (caught) {
			error = caught;
		}
		expect(error?.code).toBe("INVALID_BUDGET");
		expect(h.manager.entries).toHaveLength(0);
		expect(h.parent.remaining).toEqual({ read: 1, bash: 1 });
		expect(h.manager.getLeafId()).toBe(null);
	});

	test("a pending descriptor is resolved by id, never used as the batch", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-d");
		expect(reserve(h).ok).toBe(true);
		// The station stores this lightweight shape; a hook may hand it back.
		const descriptor = {
			batchId: registered.batchId,
			toolCallId: "call-d",
			stage: h.begin.stage,
			flows: h.begin.fission,
			retired: false,
		};
		const outcome = await h.scheduler.onOwnerEnd({ batch: descriptor });
		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe(FISSION_SCHEDULER_CODES.ACK_MISSING);
		expect(outcome.detail).toContain("toolResult for call-d is not persisted");
		expect(descriptor.startPromise).toBeUndefined();
		const status = h.scheduler.batchStatus(registered.batchId);
		expect(status.status).toBe("failed");
		expect(status.flows).toEqual([]);
		expect(h.scheduler.listFlows()).toEqual([]);
	});

	test("retireOwner resolves a pending descriptor by id too", () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-h");
		const descriptor = {
			batchId: registered.batchId,
			toolCallId: "call-h",
			stage: h.begin.stage,
			flows: h.begin.fission,
			retired: false,
		};
		let contextAborted = false;
		const outcome = h.scheduler.retireOwner({
			batch: descriptor,
			ctx: {
				abort() {
					contextAborted = true;
				},
			},
		});
		expect(outcome).toEqual({ ok: true, abort: false });
		expect(h.ownerAgent.aborted).toBe(true);
		expect(contextAborted).toBe(false);
	});

	test("retirement falls back to ctx.abort when the owner agent cannot abort", () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-j");
		h.ownerAgent.abort = undefined;
		let contextAborted = false;
		const outcome = h.scheduler.retireOwner({
			batchId: registered.batchId,
			ctx: {
				abort() {
					contextAborted = true;
				},
			},
		});
		expect(outcome).toEqual({ ok: true, abort: false });
		expect(contextAborted).toBe(true);
	});

	test("flow prompts are strings that carry the intent context", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-i");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-i", content: "registered" });
		const outcome = await h.scheduler.onOwnerEnd({ batchId: registered.batchId });
		expect(outcome.ok).toBe(true);
		const items = twoFlows();
		expect(h.spawned).toHaveLength(2);
		for (const [index, { session }] of h.spawned.entries()) {
			const prompt = session.prompts[0];
			expect(typeof prompt).toBe("string");
			expect(prompt).toContain(items[index].intent);
			expect(prompt).toContain(items[index].permission);
			expect(prompt).toContain(registered.batchId);
		}
		expect(h.scheduler.listFlows().map((flow) => flow.status)).toEqual(["running", "running"]);
	});

	test("a bindFlow failure returns the original error after cleanup", async () => {
		const h = harness({
			fission: twoFlows(),
			hooks: {
				bindFlow(flowId) {
					if (flowId.endsWith(".1")) throw new Error("registry said no");
				},
			},
		});
		const registered = register(h, "call-e");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-e", content: "registered" });
		const outcome = await h.scheduler.onOwnerEnd({ batchId: registered.batchId });
		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe(FISSION_SCHEDULER_CODES.UNSUPPORTED);
		expect(outcome.detail).toContain("bindFlow failed for");
		expect(outcome.detail).toContain("registry said no");
		const status = h.scheduler.batchStatus(registered.batchId);
		expect(status.status).toBe("failed");
		expect(status.flows.map((flow) => flow.status)).toEqual(["crashed", "crashed"]);
		expect(h.bindings).toHaveLength(2);
	});

	test("a spawn failure keeps its reason and cleans without throwing", async () => {
		const h = harness({
			fission: twoFlows(),
			hooks: {
				async spawnFlow(plan) {
					// options.spawnFlow receives the derived plan: batch, flowId,
					// label, item, model, sessionManager, owner. It has no index.
					if (plan.flowId.endsWith(".1")) throw new Error("spawn boom");
					return { session: makeFlowSession(plan) };
				},
			},
		});
		const registered = register(h, "call-f");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-f", content: "registered" });
		const outcome = await h.scheduler.onOwnerEnd({ batchId: registered.batchId });
		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe(FISSION_SCHEDULER_CODES.SPAWN_FAILED);
		expect(outcome.detail).toContain("1 of 2 flow sessions could not be created");
		expect(outcome.detail).toContain("spawn boom");
		const status = h.scheduler.batchStatus(registered.batchId);
		expect(status.status).toBe("failed");
		expect(status.flows).toEqual([]);
	});

	test("a subscribe failure keeps its reason and detaches the earlier flow", async () => {
		const detached = [];
		const h = harness({
			fission: twoFlows(),
			hooks: {
				spawnFlow(plan) {
					const session = makeFlowSession(plan);
					if (plan.flowId.endsWith(".1")) {
						session.subscribe = () => {
							throw new Error("subscribe boom");
						};
					} else {
						const subscribe = session.subscribe.bind(session);
						session.subscribe = (listener) => {
							const off = subscribe(listener);
							return () => {
								detached.push(plan.flowId);
								off();
							};
						};
					}
					return { session };
				},
			},
		});
		const registered = register(h, "call-g");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-g", content: "registered" });
		const outcome = await h.scheduler.onOwnerEnd({ batchId: registered.batchId });
		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe(FISSION_SCHEDULER_CODES.UNSUPPORTED);
		expect(outcome.detail).toContain("subscribe boom");
		const [firstFlow] = h.scheduler.listFlows();
		expect(firstFlow.index).toBe(0);
		expect(detached).toEqual([firstFlow.flowId]);
		expect(h.scheduler.batchStatus(registered.batchId).flows.every(
			(flow) => flow.status === "crashed",
		)).toBe(true);
	});

	test("a nested batch keeps its parent open until the whole subtree closes", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-n1");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-n1", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [parent, sibling] = h.scheduler.listFlows();

		const nested = await startNested(h, {
			toolCallId: "call-n2",
			parentFlowId: parent.flowId,
			fission: [{ intent: "nested work", budget: { read: 1, bash: 1 }, permission: "ro" }],
		});
		const nestedFlow = h.scheduler.listFlows().find((flow) => flow.batchId === nested.batchId);
		expect(nestedFlow).toBeDefined();
		expect(h.scheduler.listFlows().find((flow) => flow.flowId === parent.flowId).nested)
			.toEqual([nested.batchId]);

		// The parent's own turn may end first, but the subtree is still open:
		// no scope.end, no handoff, and the parent stays "ending".
		await h.scheduler.flowEnded(parent.flowId);
		expect(h.scheduler.listFlows().find((flow) => flow.flowId === parent.flowId).status).toBe("ending");
		expect(h.scheduler.batchStatus(registered.batchId).handoffs).toHaveLength(0);

		const nestedSession = h.spawned.find(({ plan }) => plan.flowId === nestedFlow.flowId).session;
		nestedSession.finish.resolve();
		await h.scheduler.flowEnded(nestedFlow.flowId);
		const nestedDone = await h.scheduler.waitForBatch(nested.batchId);
		expect(nestedDone.status).toBe("closed");
		expect(nestedDone.flows.map((flow) => flow.status)).toEqual(["closed"]);
		await waitFor(() =>
			h.scheduler.listFlows().find((flow) => flow.flowId === parent.flowId).status === "closed",
		);

		// The parent's segment now carries the nested flow's whole scope and
		// is copied into the sibling before the sibling finishes.
		await waitFor(() => h.scheduler.batchStatus(registered.batchId).handoffs.length === 0);
		expect(h.spawned[1].session.agent.state.messages.some((message) =>
			typeof message.content === "string" && message.content.includes(nested.batchId),
		)).toBe(true);

		h.spawned[1].session.finish.resolve();
		await h.scheduler.flowEnded(sibling.flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("closed");
		expect(done.heir).toBe(sibling.label);
		expect(done.flows.map((flow) => flow.status)).toEqual(["closed", "closed"]);
	});

	test("broadcast reaches every leaf, including a sibling beside a nested batch", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-bc");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-bc", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [parent, sibling] = h.scheduler.listFlows();
		const nested = await startNested(h, {
			toolCallId: "call-bc-n1",
			parentFlowId: parent.flowId,
			fission: [{ intent: "nested work", budget: { read: 1, bash: 1 }, permission: "ro" }],
		});
		const nestedFlow = h.scheduler.listFlows().find((flow) => flow.batchId === nested.batchId);

		// The parent has retired behind its nested batch; its sibling is a leaf
		// of its own and must not disappear from the leaf set. activeLeaves()
		// publishes the scheduler's internal flow objects (`id`); listFlows()
		// is the projected view (`flowId`), so each is read by its own contract.
		expect(h.scheduler.activeLeaves().map((flow) => flow.id).sort())
			.toEqual([sibling.flowId, nestedFlow.flowId].sort());

		const parentSession = h.spawned.find(({ plan }) => plan.flowId === parent.flowId).session;
		const siblingSession = h.spawned.find(({ plan }) => plan.flowId === sibling.flowId).session;
		const nestedSession = h.spawned.find(({ plan }) => plan.flowId === nestedFlow.flowId).session;
		const expectedRecipients = [sibling.label, nestedFlow.label].sort();

		const result = h.scheduler.broadcast("stop and report");
		expect(result.ok).toBe(true);
		expect([...result.recipients].sort()).toEqual(expectedRecipients);
		expect([...result.delivered].sort()).toEqual(expectedRecipients);
		expect(parentSession.agent.steered).toEqual([]);
		for (const session of [siblingSession, nestedSession]) {
			expect(session.agent.steered).toHaveLength(1);
			const [message] = session.agent.steered;
			expect(message.content.startsWith("(broadcast to 2 flows)")).toBe(true);
			expect(message.details.fissionBroadcast.broadcastId).toBe(result.broadcastId);
			expect([...message.details.fissionBroadcast.recipients].sort()).toEqual(expectedRecipients);
		}

		const empty = h.scheduler.broadcast("   ");
		expect(empty.ok).toBe(false);
		expect(empty.code).toBe(FISSION_SCHEDULER_CODES.INVALID_REQUEST);
	});

	test("cancelling one flow leaves its sibling running and yields to the sibling heir", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-cancel");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-cancel", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [first, second] = h.scheduler.listFlows();

		const cancelled = h.scheduler.cancelFlow(first.flowId, "user pressed Esc");
		expect(cancelled).toEqual({ ok: true, flowId: first.flowId, reason: "user pressed Esc" });
		expect(h.spawned[0].session.agent.aborted).toBe(true);
		await h.scheduler.flowEnded(first.flowId);
		await waitFor(() =>
			h.scheduler.listFlows().find((flow) => flow.flowId === first.flowId).status === "cancelled",
		);
		expect(h.scheduler.listFlows().find((flow) => flow.flowId === second.flowId).status).toBe("running");
		expect(h.scheduler.batchStatus(registered.batchId).handoffs).toHaveLength(0);
		expect(h.manager.getEntries().some((entry) =>
			entry.customType === "fission.aborted" && entry.data?.flow === first.label,
		)).toBe(true);

		h.spawned[1].session.finish.resolve();
		await h.scheduler.flowEnded(second.flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("closed");
		expect(done.heir).toBe(second.label);
		expect(done.flows.map((flow) => flow.status)).toEqual(["cancelled", "closed"]);
		expect(done.handoffs).toEqual([]);
	});

	test("a flow crash is recorded as aborted and does not block its sibling", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-crash");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-crash", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [first, second] = h.scheduler.listFlows();

		h.spawned[0].session.finish.reject(new Error("provider exploded"));
		await waitFor(() =>
			h.scheduler.listFlows().find((flow) => flow.flowId === first.flowId).status === "crashed",
		);
		const aborted = h.manager.getEntries().find((entry) =>
			entry.customType === "fission.aborted" && entry.data?.flowId === first.flowId,
		);
		expect(aborted.data.reason).toContain("provider exploded");

		h.spawned[1].session.finish.resolve();
		await h.scheduler.flowEnded(second.flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("closed");
		expect(done.flows.map((flow) => flow.status)).toEqual(["crashed", "closed"]);
		expect(done.heir).toBe(second.label);
		expect(h.ownerAgent.state.messages).toEqual(h.spawned[1].session.agent.state.messages);
	});

	test("cancelAll aborts every running flow and ends the batch cancelled", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-all");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-all", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const flows = h.scheduler.listFlows();

		const results = h.scheduler.cancelAll("stop");
		expect(results.map((result) => result.flowId).sort())
			.toEqual(flows.map((flow) => flow.flowId).sort());
		expect(h.spawned.every(({ session }) => session.agent.aborted)).toBe(true);
		for (const flow of flows) await h.scheduler.flowEnded(flow.flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("cancelled");
		expect(done.flows.map((flow) => flow.status)).toEqual(["cancelled", "cancelled"]);
		expect(h.ownerAgent.state.messages).toEqual([]);
	});

	test("a cost cap on the last flow ends the batch cost-capped, not cancelled", async () => {
		const h = harness({ fission: [{ intent: "only", budget: { read: 2, bash: 1 }, permission: "ro" }] });
		const registered = register(h, "call-cap");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-cap", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [only] = h.scheduler.listFlows();

		const capped = h.scheduler.noteCostCap(only.flowId, "cost-capped");
		expect(capped.ok).toBe(true);
		expect(h.spawned[0].session.agent.aborted).toBe(true);
		await h.scheduler.flowEnded(only.flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("cost-capped");
		expect(done.flows.map((flow) => flow.status)).toEqual(["cancelled"]);
		const end = h.manager.getEntries().find((entry) =>
			entry.customType === "scope.end" && entry.data?.batchId === registered.batchId,
		);
		expect(end.data.status).toBe("cost-capped");
		// No closed flow exists, so the owner's context is not adopted.
		expect(h.ownerAgent.state.messages).toEqual([]);
	});

	test("cancelling a flow aborts its nested subtree at every depth", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-deep");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-deep", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [parent, sibling] = h.scheduler.listFlows();

		const nested = await startNested(h, {
			toolCallId: "call-deep-n1",
			parentFlowId: parent.flowId,
			fission: [{ intent: "middle", budget: { read: 1, bash: 1 }, permission: "ro" }],
		});
		const middle = h.scheduler.listFlows().find((flow) => flow.batchId === nested.batchId);
		const grand = await startNested(h, {
			toolCallId: "call-deep-n2",
			parentFlowId: middle.flowId,
			fission: [{ intent: "leaf", budget: { read: 1, bash: 1 }, permission: "ro" }],
		});
		const leaf = h.scheduler.listFlows().find((flow) => flow.batchId === grand.batchId);
		const middleSession = h.spawned.find(({ plan }) => plan.flowId === middle.flowId).session;
		const leafSession = h.spawned.find(({ plan }) => plan.flowId === leaf.flowId).session;

		expect(h.scheduler.cancelFlow(parent.flowId, "stop subtree").ok).toBe(true);
		expect(h.spawned[0].session.agent.aborted).toBe(true);
		expect(middleSession.agent.aborted).toBe(true);
		expect(leafSession.agent.aborted).toBe(true);

		// The cancelled subtree still unwinds in order: the leaf's batch closes
		// first and releases the middle flow, which releases the parent.
		await h.scheduler.flowEnded(leaf.flowId);
		await waitFor(() =>
			h.scheduler.listFlows().find((flow) => flow.flowId === parent.flowId).status === "cancelled",
		);
		expect(h.scheduler.listFlows().find((flow) => flow.flowId === middle.flowId).status).toBe("cancelled");

		h.spawned[1].session.finish.resolve();
		await h.scheduler.flowEnded(sibling.flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("closed");
		expect(done.heir).toBe(sibling.label);
		expect(done.flows.map((flow) => flow.status)).toEqual(["cancelled", "closed"]);
	});
});
