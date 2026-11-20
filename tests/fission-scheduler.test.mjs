import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
	FISSION_SCHEDULER_CODES,
	createFissionScheduler,
} from "../src/host/fission-scheduler.mjs";
import { FISSION_MANAGER } from "../src/host/fission-manager.mjs";
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

function harness({ fission, budget = { read: 10, bash: 4 }, hooks = {}, seed }) {
	const manager = makeJournal();
	seed?.(manager);
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

/** The registration contract a flow proxy exposes: its marker and wrapped manager. */
function flowProxy(shared) {
	return { [FISSION_MANAGER]: true, shared };
}

describe("fission scheduler manager identity", () => {
	test("accepts a flow proxy over the scheduler's shared manager", () => {
		const h = harness({ fission: twoFlows() });
		const registered = h.scheduler.registerBatch({
			toolCallId: "call-proxy",
			sessionManager: flowProxy(h.manager),
			station: h.station,
			ctx: { agent: { id: "owner" } },
			begin: h.begin,
			flows: h.begin.fission,
			totals: h.totals,
			stage: h.begin.stage,
			mainAgent: true,
		});

		expect(registered.ok).toBe(true);
	});

	test("refuses a flow proxy over a different shared journal", () => {
		const h = harness({ fission: twoFlows() });
		expect(() => h.scheduler.registerBatch({
			toolCallId: "call-foreign-proxy",
			sessionManager: flowProxy({}),
			station: h.station,
			ctx: { agent: { id: "owner" } },
			begin: h.begin,
			flows: h.begin.fission,
			totals: h.totals,
			stage: h.begin.stage,
			mainAgent: true,
		})).toThrow(/different SessionManager/);
	});
});

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
			// The owner's ack is a sibling, not an ancestor: every flow hangs
			// under its own receipt, which hangs under the shared batch begin.
			expect(h.manager.getEntry(flow.receiptId).parentId).toBe(registered.batchBeginId);
			expect(h.manager.getEntry(flow.beginId).parentId).toBe(flow.receiptId);
			expect(h.manager.getEntry(flow.receiptId).message.toolCallId).toBe("call-a");
			expect(h.manager.getBranch(flow.beginId).some((entry) => entry.id === ackId)).toBe(false);
		}
		expect(h.bindings[0].station.state.scopes.at(-1).intent).toBe("first");
		expect(h.bindings[1].station.state.scopes.at(-1).intent).toBe("second");
		for (const [index, { session }] of h.spawned.entries()) {
			expect(session.agent.state.messages.length).toBeGreaterThan(0);
			// The ack prefix stops at the batch begin, so the flow's own begin
			// is scheduler-written and must be injected explicitly.
			expect(session.agent.state.messages.some((message) =>
				message.customType === "scope.begin" &&
				JSON.parse(message.content).flow === flows[index].label,
			)).toBe(true);
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

	test("each flow sees the shared tool call and its own receipt", async () => {
		const h = harness({ fission: twoFlows() });
		const items = twoFlows();
		const toolCallId = "call-receipt";
		const toolCallEntry = h.manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "scope", arguments: { begin: true } }],
			toolCalls: [{ id: toolCallId, name: "scope", arguments: { begin: true } }],
			timestamp: 1,
		});
		const registered = register(h, toolCallId);
		expect(h.manager.getEntry(registered.batchBeginId).parentId).toBe(toolCallEntry);
		expect(reserve(h).ok).toBe(true);
		const ackId = h.manager.appendMessage({
			role: "toolResult",
			toolCallId,
			content: "owner receipt",
		});
		await h.scheduler.onOwnerEnd({ batch: registered.batch });

		const flows = h.scheduler.listFlows();
		expect(flows.map((flow) => flow.receiptId)).toHaveLength(2);
		expect(new Set(flows.map((flow) => flow.receiptId)).size).toBe(2);
		for (const [index, flow] of flows.entries()) {
			const receipt = h.manager.getEntry(flow.receiptId);
			expect(receipt.type).toBe("message");
			expect(receipt.parentId).toBe(registered.batchBeginId);
			expect(receipt.message.role).toBe("toolResult");
			expect(receipt.message.toolName).toBe("scope");
			expect(receipt.message.isError).toBe(false);
			expect(Array.isArray(receipt.message.content)).toBe(true);
			expect(receipt.message.content).toHaveLength(1);
			expect(receipt.message.content[0].type).toBe("text");
			expect(typeof receipt.message.content[0].text).toBe("string");
			expect(receipt.message.toolCallId).toBe(toolCallId);
			expect(receipt.message.details.fissionReceipt.flowId).toBe(flow.flowId);
			// The receipt, not the prompt, states this flow's assignment.
			const text = receipt.message.content[0].text;
			expect(text).toContain(items[index].intent);
			for (const [tool, amount] of Object.entries(items[index].budget)) {
				expect(text).toContain(`${tool} ${amount}`);
			}
			expect(text).toContain(`Permission: ${items[index].permission}.`);
			expect(text).toContain("Model: owner-model.");
			// Disk parent chain: the shared toolCall and batch begin are
			// ancestors of exactly one receipt and one flow begin.
			expect(h.manager.getEntry(flow.beginId).parentId).toBe(flow.receiptId);
			const branch = h.manager.getBranch(flow.beginId);
			expect(branch.some((entry) => entry.id === ackId)).toBe(false);
			expect(branch.filter((entry) =>
				entry.type === "message" && entry.message?.toolCallId === toolCallId,
			)).toHaveLength(1);

			const messages = h.spawned[index].session.agent.state.messages;
			const callIndex = messages.findIndex((message) =>
				message.role === "assistant" && JSON.stringify(message).includes(toolCallId),
			);
			const receiptIndex = messages.findIndex((message) =>
				message.role === "toolResult" && message.toolCallId === toolCallId,
			);
			expect(callIndex).toBeGreaterThanOrEqual(0);
			// The shared call is followed directly by this flow's own result;
			// the batch boundary follows the receipt, not the call.
			expect(receiptIndex).toBe(callIndex + 1);
			expect(messages.filter((message) =>
				message.role === "toolResult" && message.toolCallId === toolCallId,
			)).toHaveLength(1);
			const batchIndex = messages.findIndex((message) =>
				message.customType === "scope.begin" &&
				JSON.parse(message.content).fissionBatch === true,
			);
			const flowIndex = messages.findIndex((message) =>
				message.customType === "scope.begin" &&
				JSON.parse(message.content).flow === flow.label,
			);
			expect(receiptIndex).toBeLessThan(batchIndex);
			expect(batchIndex).toBeLessThan(flowIndex);
			// Every flow sees the identical original call message object.
			expect(h.spawned[0].session.agent.state.messages[0]).toBe(messages[0]);
		}
	});

	test("an assistant error stop reason crashes the flow instead of closing it", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-stop-error");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-stop-error", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });

		const flows = h.scheduler.listFlows();
		h.spawned[0].session.agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "provider failed" }],
			stopReason: "error",
			errorMessage: "provider failed",
			timestamp: Date.now(),
		});
		h.spawned[0].session.finish.resolve();
		await h.scheduler.flowEnded(flows[0].flowId);

		expect(h.scheduler.listFlows()[0].status).toBe("crashed");
		// The sibling keeps running; the batch fails only once every flow stops.
		expect(h.scheduler.listFlows()[1].status).toBe("running");
		h.spawned[1].session.finish.resolve();
		await h.scheduler.flowEnded(flows[1].flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("failed");
		expect(done.outcome).toBe("failed");
		expect(done.flows[0].status).toBe("crashed");
		expect(done.flows[1].status).not.toBe("crashed");
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
		// Both scopes the batch opened are closed. The heir's own scope closes
		// before promotion, so the batch scope is on top and pops last; the
		// owner is back at the scope it opened before the batch.
		expect(h.state.scopes.map((scope) => scope.id)).toEqual([h.parent.id]);
		expect(currentScope(h.state).id).toBe(h.parent.id);
		// The scheduler's own boundaries enter the model's context in journal
		// order: the heir's scope.end, then the batch scope.end.
		const endPayloads = h.ownerAgent.state.messages
			.filter((message) => message.customType === "scope.end")
			.map((message) => JSON.parse(message.content));
		expect(endPayloads.filter((payload) => payload.flow === second.label)).toHaveLength(1);
		expect(endPayloads.at(-1).batchId).toBe(registered.batchId);
		expect(endPayloads.at(-1).flow).toBeUndefined();
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

	test("startup retires a chained half handoff without claiming it was delivered", async () => {
		let target;
		const h = harness({
			fission: twoFlows(),
			seed(manager) {
				target = manager.appendMessage({ role: "user", content: "target" });
				manager.branch(target);
				manager.appendCustomEntry("fission.handoff.begin", {
					handoffId: "half-safe",
					sourceBeginId: "source-safe",
				});
				manager.appendMessage({ role: "user", content: "half copy" });
			},
		});
		const registered = register(h, "call-recover-safe");
		expect(registered.ok).toBe(true);
		expect(h.scheduler.inspectIncompleteHandoffs()).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const log = h.scheduler.handoffRecoveryLog();
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({
			ok: true,
			mode: "retire",
			delivered: false,
			replayable: false,
		});
		expect(log[0].retired).toHaveLength(1);
		expect(log[0].retired[0]).toMatchObject({ handoffId: "half-safe", tail: target });
		// The new batch begin follows the abort marker, never the abandoned
		// half copy.
		expect(h.manager.getEntry(registered.batchBeginId).parentId).toBe(log[0].retired[0].abortId);
	});

	test("startup refuses a multi-tail handoff and writes no batch begin", () => {
		const h = harness({
			fission: twoFlows(),
			seed(manager) {
				const tailA = manager.appendMessage({ role: "user", content: "tail A" });
				manager.branch(tailA);
				manager.appendCustomEntry("fission.handoff.begin", {
					handoffId: "half-unsafe",
					sourceBeginId: "source-unsafe",
				});
				manager.appendMessage({ role: "user", content: "copy A" });
				manager.branch(tailA);
				manager.appendMessage({ role: "user", content: "tail B" });
				manager.appendCustomEntry("fission.handoff.begin", {
					handoffId: "half-unsafe",
					sourceBeginId: "source-unsafe",
				});
				manager.appendMessage({ role: "user", content: "copy B" });
			},
		});
		let failure;
		try {
			register(h, "call-recover-unsafe");
		} catch (error) {
			failure = error;
		}
		expect(failure?.code).toBe(FISSION_SCHEDULER_CODES.HANDOFF_RECOVERY_UNSAFE);
		expect(h.manager.getEntries().some((entry) =>
			entry.customType === "scope.begin" && entry.data?.fissionBatch === true,
		)).toBe(false);
		const inspect = h.scheduler.inspectIncompleteHandoffs();
		expect(inspect).toHaveLength(1);
		expect(inspect[0].recoverable).toBe(false);
		expect(inspect[0].reason).toContain("more than one tail");
		expect(h.scheduler.handoffRecoveryLog()[0]).toMatchObject({
			ok: false,
			code: FISSION_SCHEDULER_CODES.HANDOFF_RECOVERY_UNSAFE,
		});
	});

	test("the constructor refuses a journal without a session file and writes nothing", () => {
		const manager = makeJournal();
		const tail = manager.appendMessage({ role: "user", content: "tail" });
		manager.branch(tail);
		manager.appendCustomEntry("fission.handoff.begin", {
			handoffId: "half-no-session-file",
			sourceBeginId: "source-no-session-file",
		});
		manager.appendMessage({ role: "user", content: "half copy" });
		const entriesBefore = manager.getEntries().map((entry) => entry.id);
		// The constructor contract needs a persistent session. A manager whose
		// session file is unavailable is rejected before any recovery write.
		manager.getSessionFile = () => null;
		let failure;
		try {
			createFissionScheduler({
				manager,
				levelTemplate: LEVEL_TEMPLATE,
				bindFlow() {},
				vibeActive: false,
			});
		} catch (error) {
			failure = error;
		}
		expect(failure?.code).toBe(FISSION_SCHEDULER_CODES.UNSUPPORTED);
		expect(String(failure?.message ?? failure?.detail)).toContain("persistent session file");
		expect(manager.getEntries().map((entry) => entry.id)).toEqual(entriesBefore);
		expect(manager.getEntries().some((entry) =>
			entry.customType === "scope.begin" && entry.data?.fissionBatch === true,
		)).toBe(false);
	});

	test("recovery refuses at register when durable writes disappear after construction", () => {
		const h = harness({
			fission: twoFlows(),
			seed(manager) {
				const tail = manager.appendMessage({ role: "user", content: "tail" });
				manager.branch(tail);
				manager.appendCustomEntry("fission.handoff.begin", {
					handoffId: "half-no-durable",
					sourceBeginId: "source-no-durable",
				});
				manager.appendMessage({ role: "user", content: "half copy" });
			},
		});
		delete h.manager.appendEntriesAtomically;
		let failure;
		try {
			register(h, "call-recover-no-durable");
		} catch (error) {
			failure = error;
		}
		expect(failure?.code).toBe(FISSION_SCHEDULER_CODES.HANDOFF_RECOVERY_REQUIRED);
		expect(String(failure?.message ?? failure?.detail)).toContain("durable");
		const inspect = h.scheduler.inspectIncompleteHandoffs();
		expect(inspect[0].recoverable).toBe(false);
		expect(inspect[0].reason).toContain("durable");
		expect(h.manager.getEntries().some((entry) =>
			entry.customType === "scope.begin" && entry.data?.fissionBatch === true,
		)).toBe(false);
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
		// The registered begin is closed even though the owner's scope stack
		// never entered the batch.
		const end = h.manager.getEntry(h.manager.getLeafId());
		expect(end.customType).toBe("scope.end");
		expect(end.data.batchId).toBe(registered.batchId);
		expect(end.data.status).toBe("failed");
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
		const end = h.manager.getEntry(h.manager.getLeafId());
		expect(end.customType).toBe("scope.end");
		expect(end.data.batchId).toBe(registered.batchId);
		expect(end.data.status).toBe("failed");
		// The failure happened before any receipt or flow boundary, so the
		// journal has no flow scope to close.
		expect(h.manager.getEntries().some((entry) =>
			entry.customType === "scope.end" && entry.data?.flow,
		)).toBe(false);
	});

	test("cancelBatch before start closes the registered batch boundary", async () => {
		const h = harness({ fission: twoFlows() });
		const depth = h.state.scopes.length;
		const registered = register(h, "call-cancel-close");
		const result = h.scheduler.cancelBatch(registered.batchId, "reservation refused");
		expect(result.ok).toBe(true);
		expect(result.status).toBe("cancelled");
		// Registration only wrote the journal boundary; cancellation must not
		// move the owner's in-memory scope stack.
		expect(h.state.scopes).toHaveLength(depth);
		const end = h.manager.getEntry(h.manager.getLeafId());
		expect(end.customType).toBe("scope.end");
		expect(end.data.batchId).toBe(registered.batchId);
		expect(end.data.status).toBe("cancelled");
		expect(h.scheduler.batchStatus(registered.batchId).status).toBe("cancelled");
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
		// Every nested boundary closes in order: the nested batch scope, then
		// the parent flow scope, then the outer batch scope.
		expect(h.state.scopes.map((scope) => scope.id)).toEqual([h.parent.id]);
		expect(currentScope(h.state).id).toBe(h.parent.id);
		// The nested batch's scope.end reached the parent flow's context through
		// the nested heir, not only the journal.
		const parentSession = h.spawned.find(({ plan }) => plan.flowId === parent.flowId).session;
		expect(parentSession.agent.state.messages.some((message) =>
			message.customType === "scope.end" &&
			JSON.parse(message.content).batchId === nested.batchId,
		)).toBe(true);
	});

	test("a nested registration racing the parent finish is refused", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-race-parent");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-race-parent", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [parent, sibling] = h.scheduler.listFlows();
		const beginsBefore = h.manager.getEntries().filter((entry) =>
			entry.customType === "scope.begin" && entry.data?.fissionBatch === true,
		).length;

		// finishFlow seals the flow synchronously before its first await. A
		// nested begin arriving in that window must be refused, never left
		// dangling under a flow that is about to close.
		const finishing = h.scheduler.flowEnded(parent.flowId);
		let failure;
		try {
			await startNested(h, {
				toolCallId: "call-race-child",
				parentFlowId: parent.flowId,
				fission: [{ intent: "late child", budget: { read: 1 }, permission: "ro" }],
			});
		} catch (error) {
			failure = error;
		}
		expect(failure?.code).toBe(FISSION_SCHEDULER_CODES.PARENT_CLOSED);
		expect(h.manager.getEntries().filter((entry) =>
			entry.customType === "scope.begin" && entry.data?.fissionBatch === true,
		)).toHaveLength(beginsBefore);
		await finishing;
		expect(h.scheduler.listFlows().find((flow) => flow.flowId === parent.flowId).status).toBe("closed");
		expect(h.scheduler.listFlows().find((flow) => flow.flowId === sibling.flowId).status).toBe("running");
	});

	test("a registered but unstarted nested batch keeps its parent open", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-hold-parent");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-hold-parent", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [parent, sibling] = h.scheduler.listFlows();
		const binding = h.bindings.find((item) => item.flowId === parent.flowId);
		const begin = {
			stage: "architecture-design",
			elder_report: null,
			fission: [{ intent: "nested hold", budget: { read: 1, bash: 1 }, permission: "ro" }],
		};
		const nested = h.scheduler.registerBatch({
			toolCallId: "call-hold-child",
			sessionManager: h.manager,
			station: binding.station,
			ctx: { agent: { id: parent.flowId } },
			identity: { id: parent.flowId },
			begin,
			flows: begin.fission,
			totals: totalsOf(begin.fission),
			stage: begin.stage,
			mainAgent: true,
			nested: true,
		});
		expect(nested.ok).toBe(true);
		// The host persisted the child's tool result, but its agent_end has not
		// started the spawn yet.
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-hold-child", content: "registered" });

		await h.scheduler.flowEnded(parent.flowId);
		expect(h.scheduler.listFlows().find((flow) => flow.flowId === parent.flowId).status).toBe("ending");
		// settleFlow started the registered child; the parent cannot close until
		// the whole nested subtree is done.
		await waitFor(() => h.scheduler.listFlows().some((flow) => flow.batchId === nested.batchId));
		const nestedFlow = h.scheduler.listFlows().find((flow) => flow.batchId === nested.batchId);
		const nestedSession = h.spawned.find(({ plan }) => plan.flowId === nestedFlow.flowId).session;
		nestedSession.finish.resolve();
		await h.scheduler.flowEnded(nestedFlow.flowId);
		await h.scheduler.waitForBatch(nested.batchId);
		await waitFor(() =>
			h.scheduler.listFlows().find((flow) => flow.flowId === parent.flowId).status === "closed",
		);

		h.spawned[1].session.finish.resolve();
		await h.scheduler.flowEnded(sibling.flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("closed");
	});

	test("the last-ended sibling owns the batch after a nested child", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-order");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-order", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [first, second] = h.scheduler.listFlows();
		const nested = await startNested(h, {
			toolCallId: "call-order-child",
			parentFlowId: first.flowId,
			fission: [{ intent: "nested order", budget: { read: 1, bash: 1 }, permission: "ro" }],
		});
		const nestedFlow = h.scheduler.listFlows().find((flow) => flow.batchId === nested.batchId);

		// The parent's turn ends first and waits on the nested child.
		await h.scheduler.flowEnded(first.flowId);
		expect(h.scheduler.listFlows().find((flow) => flow.flowId === first.flowId).status).toBe("ending");

		// The sibling ends while the nested child is still running. It must
		// write its own end and queue its segment, not finalize the batch.
		h.spawned.find(({ plan }) => plan.flowId === second.flowId).session.finish.resolve();
		await h.scheduler.flowEnded(second.flowId);
		expect(h.scheduler.listFlows().find((flow) => flow.flowId === second.flowId).status).toBe("closed");
		expect(h.scheduler.batchStatus(registered.batchId).status).not.toBe("closed");

		// Finish the nested child; its completion re-runs the parent, which now
		// receives the sibling segment and becomes the heir.
		const nestedSession = h.spawned.find(({ plan }) => plan.flowId === nestedFlow.flowId).session;
		nestedSession.finish.resolve();
		await h.scheduler.flowEnded(nestedFlow.flowId);
		await h.scheduler.waitForBatch(nested.batchId);
		await waitFor(() =>
			h.scheduler.listFlows().find((flow) => flow.flowId === first.flowId).status === "closed",
		);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("closed");
		expect(done.heir).toBe(first.label);

		const entries = h.manager.getEntries();
		const position = (id) => entries.findIndex((entry) => entry.id === id);
		const firstEnd = entries.find((entry) =>
			entry.customType === "scope.end" && entry.data?.flow === first.label,
		);
		const secondEnd = entries.find((entry) =>
			entry.customType === "scope.end" && entry.data?.flow === second.label,
		);
		const batchEnd = entries.find((entry) =>
			entry.customType === "scope.end" &&
			entry.data?.batchId === registered.batchId &&
			Array.isArray(entry.data?.flows),
		);
		expect(firstEnd).toBeDefined();
		expect(secondEnd).toBeDefined();
		expect(batchEnd).toBeDefined();
		expect(position(secondEnd.id)).toBeLessThan(position(firstEnd.id));
		expect(position(firstEnd.id)).toBeLessThan(position(batchEnd.id));
		// The sibling's segment reached the parent before the parent closed.
		expect(h.spawned.find(({ plan }) => plan.flowId === first.flowId).session.agent.state.messages.some(
			(message) => typeof message.content === "string" && message.content.includes(second.label),
		)).toBe(true);
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
		// A sibling crash fails the batch summary even though the surviving
		// flow completed and adopts the conversation.
		expect(done.status).toBe("failed");
		expect(done.outcome).toBe("failed");
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

	test("a CostCapError is classified as a cost cap, not a crash", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-cap-error");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-cap-error", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [first, second] = h.scheduler.listFlows();

		const cap = Object.assign(new Error("session cost cap exceeded"), { name: "CostCapError" });
		h.spawned[0].session.finish.reject(cap);
		await waitFor(() =>
			h.scheduler.listFlows().find((flow) => flow.flowId === first.flowId).status === "cancelled",
		);
		// Only the capped flow stops; the sibling is neither aborted nor
		// classified as cancelled by it.
		expect(h.spawned[1].session.agent.aborted).toBe(false);
		expect(h.scheduler.listFlows().find((flow) => flow.flowId === second.flowId).status).toBe("running");
		const aborted = h.manager.getEntries().find((entry) =>
			entry.customType === "fission.aborted" && entry.data?.flowId === first.flowId,
		);
		expect(aborted.data.reason).toBe("cost-capped");

		h.spawned[1].session.finish.resolve();
		await h.scheduler.flowEnded(second.flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);
		expect(done.status).toBe("cost-capped");
		expect(done.flows.map((flow) => flow.status)).toEqual(["cancelled", "closed"]);
		// The survivor still takes over; the cap is reported by the batch status.
		expect(h.ownerAgent.state.messages).toEqual(h.spawned[1].session.agent.state.messages);
	});

	test("the last-ended flow takes over even when it crashed", async () => {
		const h = harness({ fission: twoFlows() });
		const registered = register(h, "call-last-crash");
		expect(reserve(h).ok).toBe(true);
		h.manager.appendMessage({ role: "toolResult", toolCallId: "call-last-crash", content: "registered" });
		await h.scheduler.onOwnerEnd({ batch: registered.batch });
		const [, second] = h.scheduler.listFlows();
		const secondSession = h.spawned[1].session;

		h.spawned[0].session.finish.reject(new Error("first exploded"));
		await waitFor(() => h.scheduler.listFlows().some((flow) => flow.status === "crashed"));
		h.spawned[1].session.finish.reject(new Error("second exploded"));
		await h.scheduler.flowEnded(second.flowId);
		const done = await h.scheduler.waitForBatch(registered.batchId);

		expect(done.status).toBe("failed");
		expect(done.heir).toBeNull();
		// The batch closes structurally and the last-ended flow still owns the
		// context, with a scope.end recorded for its failed turn.
		expect(h.ownerAgent.state.messages).toEqual(secondSession.agent.state.messages);
		expect(h.state.scopes.map((scope) => scope.id)).toEqual([h.parent.id]);
		const tip = h.manager.getBranch().at(-1);
		expect(tip.customType).toBe("scope.end");
		expect(tip.data.batchId).toBe(registered.batchId);
		const failedEnd = h.manager.getEntries().find((entry) =>
			entry.customType === "scope.end" && entry.data?.flow === second.label,
		);
		expect(failedEnd.data.status).toBe("failed");
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
