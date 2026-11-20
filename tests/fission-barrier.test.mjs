import { describe, expect, test } from "bun:test";

import { SessionStation } from "../src/station/station.mjs";
import { createState, beginScope, chargeTool, beatShares } from "../src/scope/index.mjs";
import { wireHooks } from "../src/activation/hooks.mjs";

const tickets = { steer: () => {}, canSteer: false, activateTools: () => undefined };

function makeStation(scheduler = null) {
	const station = new SessionStation(null, null, tickets, {
		fissionScheduler: () => scheduler,
	}, null);
	station.state = createState();
	station.policy = () => "main";
	station.relayOn = () => false;
	return station;
}

function assistantMessage(calls) {
	return {
		role: "assistant",
		content: calls.map((call) => ({
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: call.arguments ?? {},
		})),
		timestamp: 1,
	};
}

function toolResult(id, text = "ok") {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

describe("barrier admission", () => {
	test("todo and a second begin are refused on a trailing call", () => {
		const station = makeStation();
		station.pendingFission = {
			batchId: "b1",
			toolCallId: "scope",
			stage: "direct-execution",
			retired: false,
			totals: { read: 1 },
			trailingCallIds: ["t1", "t2"],
			remainingTrailingIds: new Set(["t1", "t2"]),
			trailingExecuted: [],
			scopeResultSeen: false,
			deadlineAt: Date.now() + 10_000,
		};
		const ctx = { agent: { id: "owner" } };

		const todo = station.onToolCall({ toolName: "todo", toolCallId: "t1" }, ctx);
		expect(todo.block).toBe(true);
		expect(todo.reason).toContain("TODO_OUTSIDE_SCOPE_ONLY");

		const second = station.onToolCall({
			toolName: "scope",
			toolCallId: "t2",
			input: { begin: { stage: "direct-execution", fission: [] } },
		}, ctx);
		expect(second.block).toBe(true);
		expect(second.reason).toContain("FISSION_BATCH_PENDING");
	});

	test("a functional call is admitted only when a flow budgets it", () => {
		const station = makeStation();
		station.pendingFission = {
			batchId: "b1",
			toolCallId: "scope",
			stage: "direct-execution",
			retired: false,
			totals: { read: 1 },
			trailingCallIds: ["t1"],
			remainingTrailingIds: new Set(["t1"]),
			trailingExecuted: [],
			scopeResultSeen: false,
			deadlineAt: Date.now() + 10_000,
		};
		const ctx = { agent: { id: "owner" } };

		expect(station.onToolCall({
			toolName: "grep",
			toolCallId: "t1",
			input: { pattern: "x" },
		}, ctx)).toMatchObject({ block: true });
		expect(station.pendingFission.trailingExecuted).toHaveLength(0);

		expect(station.onToolCall({
			toolName: "read",
			toolCallId: "t1",
			input: { path: "a.mjs" },
		}, ctx)).toBeUndefined();
		expect(station.pendingFission.trailingExecuted).toEqual([
			{ toolCallId: "t1", toolName: "read", input: { path: "a.mjs" } },
		]);
	});
});

describe("barrier retirement", () => {
	test("the owner survives the scope receipt until every trailing result", () => {
		const port = {
			retired: [],
			retireOwner(request) {
				port.retired.push(request);
				return { ok: true, abort: false };
			},
		};
		const station = makeStation(port);
		station.pendingFission = {
			batchId: "b1",
			toolCallId: "scope",
			remainingTrailingIds: new Set(["t1"]),
			trailingExecuted: [],
			scopeResultSeen: false,
			retired: false,
		};
		let aborted = 0;
		const ctx = { agent: { id: "owner" }, abort: () => { aborted += 1; } };

		const handlers = new Map();
		const pi = { on: (event, handler) => { handlers.set(event, handler); return () => {}; } };
		wireHooks(pi, {
			stationFor: () => station,
			stationForStop: () => station,
			fissionScheduler: () => port,
			bindFlow: () => {},
			unbindFlow: () => {},
		});
		const onResult = handlers.get("tool_result");

		onResult({ toolCallId: "scope" }, ctx);
		expect(station.pendingFission.retired).toBe(false);
		expect(aborted).toBe(0);

		onResult({ toolCallId: "t1" }, ctx);
		expect(station.pendingFission.retired).toBe(true);
		expect(port.retired).toHaveLength(1);
	});
});

describe("shared first beat", () => {
	test("one unit is split across the beat's functional tools", () => {
		const shares = beatShares([
			{ name: "read", free: false },
			{ name: "grep", free: false },
			{ name: "scope", free: true },
		]);
		expect(shares).toEqual({ read: 0.5, grep: 0.5 });
	});

	test("a flow pays only for tools it budgeted", () => {
		const state = createState();
		const scope = beginScope(state, {
			intent: "flow",
			stage: "direct-execution",
			budget: { read: 1 },
			time: 60,
		}).scope;
		const beatTools = [
			{ name: "read", free: false },
			{ name: "grep", free: false },
		];
		const charged = chargeTool(state, {
			toolCallId: "c1",
			toolName: "read",
			beatTools,
			input: undefined,
		});
		expect(charged.ok).toBe(true);
		expect(scope.remaining.read).toBe(0.5);
		expect(scope.remaining.grep).toBeUndefined();
	});
});

