import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
		getSessionFile: () => "/virtual/barrier-session.jsonl",
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
		resetLeaf: () => { leaf = null; },
		appendMessage: (message) => appendHere({ type: "message", message }),
		appendCustomEntry: (customType, data) => appendHere({ type: "custom", customType, data }),
		appendEntriesAtomically: async (write) => write(),
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
		state: { messages: [], isStreaming: false },
		aborted: false,
		reset() { agent.state.messages.length = 0; },
		abort() { agent.aborted = true; },
		steer() {},
		followUp() {},
		clearSteeringQueue() {},
		clearFollowUpQueue() {},
		peekSteeringQueue() { return []; },
		peekFollowUpQueue() { return []; },
		peekUndeliveredQueuedMessages() { return []; },
		withdrawUndeliveredQueuedMessages() { return { steering: [], followUp: [] }; },
		replaceQueue() {},
	};
	return agent;
}

function makeFlowSession(id) {
	const agent = makeAgent(id);
	agent.continue = () => new Promise(() => {});
	return {
		agent,
		model: { id: "flow-model" },
		getAgentId: () => id,
		settleInFlightMessagePersistence: async () => {},
		subscribe: () => () => {},
	};
}

function assistant(calls) {
	return {
		role: "assistant",
		content: calls.map((call) => ({
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: call.arguments ?? {},
		})),
		timestamp: 10,
	};
}

function result(call, text) {
	return {
		role: "toolResult",
		toolCallId: call,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 11,
	};
}

describe("barrier integration", () => {
	test("shared results sit between the receipt and the flow begin on disk and in memory", async () => {
		const manager = makeJournal();
		const state = createState();
		beginScope(state, {
			intent: "owner",
			stage: "architecture-design",
			budget: { read: 10, grep: 10 },
			time: 60,
		});
		const ownerAgent = makeAgent("owner");
		const ownerSession = {
			agent: ownerAgent,
			model: { id: "owner-model" },
			subscribe: () => () => {},
			settleInFlightMessagePersistence: async () => {},
		};
		const bindings = [];
		const spawned = [];
		const scheduler = createFissionScheduler({
			manager,
			session: ownerSession,
			agent: ownerAgent,
			levelTemplate: LEVEL_TEMPLATE,
			vibeActive: false,
			bindFlow(flowId, station, permission, meta) {
				bindings.push({ flowId, station, permission, meta });
			},
			unbindFlow() {},
			spawnFlow(plan) {
				const session = makeFlowSession(plan.flowId);
				// createAgentSession restores the existing journal before the
				// scheduler installs this flow's own branch and receipt.
				session.agent.state.messages = structuredClone(ownerAgent.state.messages);
				spawned.push(session);
				return { session };
			},
		});

		const fission = [
			{ intent: "first", budget: { read: 1, grep: 1 }, permission: "ro" },
			{ intent: "second", budget: { read: 1, grep: 1 }, permission: "rw" },
		];
		const begin = { stage: "architecture-design", elder_report: null, time: 60, fission };
		const station = {
			state,
			manager,
			registry: { fissionScheduler: () => scheduler },
			policy: () => "main",
			relayOn: () => false,
			persist() {},
		};
		const registered = scheduler.registerBatch({
			toolCallId: "scope-call",
			sessionManager: manager,
			station,
			ctx: { agent: { id: "owner" } },
			begin,
			flows: fission,
			totals: { read: 2, grep: 2 },
			stage: begin.stage,
			mainAgent: true,
		});
		expect(splitFissionBudget(state, begin, { mainAgent: true, relayOn: false }).ok).toBe(true);

		const open = assistant([
			{ id: "scope-call", name: "scope", arguments: { begin } },
			{ id: "t1", name: "read", arguments: { path: "a.mjs" } },
			{ id: "t2", name: "grep", arguments: { pattern: "x" } },
		]);
		const ack = {
			role: "toolResult",
			toolCallId: "scope-call",
			toolName: "scope",
			content: [{ type: "text", text: "registered" }],
			isError: false,
			timestamp: 12,
		};
		const r1 = result("t1", "a.mjs content");
		const r2 = result("t2", "match");
		ownerAgent.state.messages.push(open, ack, r1, r2);
		for (const message of [open, ack, r1, r2]) manager.appendMessage(message);

		station.pendingFission = {
			batchId: registered.batchId,
			toolCallId: "scope-call",
			stage: begin.stage,
			retired: true,
			totals: { read: 2, grep: 2 },
			trailingCallIds: ["t1", "t2"],
			remainingTrailingIds: new Set(),
			trailingExecuted: [
				{ toolCallId: "t1", toolName: "read", input: { path: "a.mjs" } },
				{ toolCallId: "t2", toolName: "grep", input: { pattern: "x" } },
			],
			scopeResultSeen: true,
			deadlineAt: Date.now() + 10_000,
		};

		scheduler.retireOwner({ batch: registered.batch });
		const outcome = await scheduler.onOwnerEnd({ batch: registered.batch });
		expect(outcome.ok).toBe(true);
		expect(bindings).toHaveLength(2);

		const flows = scheduler.listFlows();
		for (const [index, flow] of flows.entries()) {
			const branch = manager.getBranch(flow.beginId);
			const tail = branch.slice(-4);
			expect(tail[0].type).toBe("message");
			expect(tail[0].message.toolCallId).toBe("scope-call");
			expect(tail[1].type).toBe("message");
			expect(tail[1].message.toolCallId).toBe("t1");
			expect(tail[2].type).toBe("message");
			expect(tail[2].message.toolCallId).toBe("t2");
			expect(tail[3].customType).toBe("scope.begin");

			const messages = spawned[index].agent.state.messages;
			expect(messages.filter((message) => message.role === "assistant")).toEqual([open]);
			expect(messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId))
				.toEqual(["scope-call", "t1", "t2"]);
			const receiptAt = messages.findIndex(
				(message) =>
					message?.role === "toolResult" &&
					message.toolCallId === "scope-call" &&
					message.details?.fissionReceipt != null,
			);
			expect(receiptAt).toBeGreaterThanOrEqual(0);
			expect(messages[receiptAt + 1].toolCallId).toBe("t1");
			expect(messages[receiptAt + 2].toolCallId).toBe("t2");
			const beginAt = messages.findIndex(
				(message) => message?.role === "custom" && message.customType === "scope.begin",
			);
			expect(beginAt).toBeGreaterThan(receiptAt + 2);
			expect(messages.some(
				(message) =>
					message?.role === "toolResult" &&
					message.toolCallId === "scope-call" &&
					message.details?.fissionReceipt == null,
			)).toBe(false);

			const scope = bindings[index].station.state.scopes.at(-1);
			expect(scope.remaining).toEqual({ read: 0.5, grep: 0.5 });
		}
		const first = flows[0];
		scheduler.requestFlowEnd(first.flowId);
		await scheduler.flowEnded(first.flowId);
		const heir = flows[1];
		const warmed = spawned[1].agent.state.messages.slice();
		scheduler.requestFlowEnd(heir.flowId);
		await scheduler.flowEnded(heir.flowId);
		expect((await scheduler.waitForBatch(registered.batchId)).status).toBe("closed");
		expect(ownerAgent.state.messages.slice(0, warmed.length)).toEqual(warmed);
	});
});
