import { beforeEach, describe, expect, test } from "bun:test";

import {
	reset as resetDiagnostics,
	snapshot as diagnosticsSnapshot,
} from "../src/host/diagnostics.mjs";
import { announceFlowWarning } from "../src/activation/fission.mjs";
import { wireHooks } from "../src/activation/hooks.mjs";

function harness({ scheduler = null, batch = null, fissionFlow = null } = {}) {
	const handlers = new Map();
	const station = {
		pendingFission: batch,
		fissionFlow,
		lastError: null,
		stopCalls: 0,
		onAssistantMessage() {},
		onMessageEnd() {},
		onUsageMessage() {},
		onToolCall() {},
		onBeforeAgentStart() {},
		onSessionStop() {
			station.stopCalls += 1;
			return "stopped";
		},
		onSessionSwitch() {},
		onSessionCompact() {},
		prepareScopeDispatch() {},
		admitScopeDispatch() {},
	};
	const registry = {
		stationFor: () => station,
		stationForStop: () => station,
		fissionScheduler: () => scheduler,
	};
	const pi = {
		handlers,
		on(event, handler) {
			handlers.set(event, handler);
		},
	};
	wireHooks(pi, registry);
	return { pi, station, registry };
}

function ownerContext() {
	const ctx = { agent: { kind: "main", id: "owner" } };
	ctx.aborted = 0;
	ctx.abort = () => {
		ctx.aborted += 1;
	};
	return ctx;
}

function emit(pi, event, payload, ctx) {
	return pi.handlers.get(event)(payload, ctx);
}

beforeEach(() => {
	resetDiagnostics();
});

describe("fission retirement wiring", () => {
	test("binds the retirement and spawn events", () => {
		const { pi } = harness();
		expect(typeof pi.handlers.get("tool_result")).toBe("function");
		expect(typeof pi.handlers.get("agent_end")).toBe("function");
	});

	test("retires the owner's batch through the scheduler and aborts the context", () => {
		const retirements = [];
		const scheduler = {
			retireOwner(request) {
				retirements.push(request);
				return { ok: true };
			},
		};
		const batch = { batchId: "b1", toolCallId: "call-1", retired: false };
		const { pi, station } = harness({ scheduler, batch });
		const ctx = ownerContext();

		emit(pi, "tool_result", { toolCallId: "call-1" }, ctx);

		expect(retirements).toHaveLength(1);
		const request = retirements[0];
		// The stop guard descriptor is not the scheduler's batch object; only
		// the id crosses so the scheduler resolves its own record.
		expect(request.batchId).toBe("b1");
		expect(request.batch).toBeUndefined();
		expect(request.station).toBe(station);
		expect(request.ctx).toBe(ctx);
		expect(batch.retired).toBe(true);
		expect(ctx.aborted).toBe(1);

		emit(pi, "tool_result", { toolCallId: "call-1" }, ctx);
		expect(retirements).toHaveLength(1);
		expect(ctx.aborted).toBe(1);
	});

	test("ignores a result for another tool call", () => {
		const retirements = [];
		const scheduler = { retireOwner: (request) => retirements.push(request) };
		const batch = { batchId: "b1", toolCallId: "call-1", retired: false };
		const { pi } = harness({ scheduler, batch });
		const ctx = ownerContext();

		emit(pi, "tool_result", { toolCallId: "call-2" }, ctx);

		expect(retirements).toHaveLength(0);
		expect(batch.retired).toBe(false);
		expect(ctx.aborted).toBe(0);
	});

	test("aborts even when no scheduler can witness the retirement", () => {
		const batch = { batchId: "b1", toolCallId: "call-1", retired: false };
		const { pi } = harness({ scheduler: null, batch });
		const ctx = ownerContext();

		emit(pi, "tool_result", { toolCallId: "call-1" }, ctx);

		expect(batch.retired).toBe(true);
		expect(ctx.aborted).toBe(1);
	});

	test("keeps the owner alive when the scheduler refuses the abort", () => {
		const scheduler = { retireOwner: () => ({ abort: false }) };
		const batch = { batchId: "b1", toolCallId: "call-1", retired: false };
		const { pi } = harness({ scheduler, batch });
		const ctx = ownerContext();

		emit(pi, "tool_result", { toolCallId: "call-1" }, ctx);

		expect(batch.retired).toBe(true);
		expect(ctx.aborted).toBe(0);
	});

	test("records a scheduler failure and still retires the owner", () => {
		const scheduler = {
			retireOwner() {
				throw new Error("journal closed");
			},
		};
		const batch = { batchId: "b1", toolCallId: "call-1", retired: false };
		const { pi, station } = harness({ scheduler, batch });
		const ctx = ownerContext();

		emit(pi, "tool_result", { toolCallId: "call-1" }, ctx);

		expect(batch.retired).toBe(true);
		expect(ctx.aborted).toBe(1);
		expect(station.lastError).toBe("journal closed");
		const records = diagnosticsSnapshot().filter((entry) => entry.domain === "hooks");
		expect(records).toHaveLength(1);
		expect(records[0].detail).toEqual({ fission: "b1", retire: true });
	});
});

describe("fission spawn wiring", () => {
	test("starts the flows only after the batch has retired", () => {
		const starts = [];
		const scheduler = {
			onOwnerEnd(request) {
				starts.push(request);
				return { started: true };
			},
		};
		const batch = { batchId: "b1", toolCallId: "call-1", retired: false };
		const { pi, station } = harness({ scheduler, batch });
		const ctx = ownerContext();
		const event = { type: "agent_end" };

		expect(emit(pi, "agent_end", event, ctx)).toBeUndefined();
		expect(starts).toHaveLength(0);

		batch.retired = true;
		expect(emit(pi, "agent_end", event, ctx)).toEqual({ started: true });

		expect(starts).toHaveLength(1);
		expect(starts[0].batchId).toBe("b1");
		expect(starts[0].station).toBe(station);
		expect(starts[0].ctx).toBe(ctx);
		expect(starts[0].event).toBe(event);
		expect(station.pendingFission).toBe(batch);
	});

	test("never starts flows from a flow's own agent_end", () => {
		const starts = [];
		const scheduler = { onOwnerEnd: (request) => starts.push(request) };
		const batch = { batchId: "b1", toolCallId: "call-1", retired: true };
		const { pi } = harness({ scheduler, batch, fissionFlow: { id: "flow-a" } });

		expect(emit(pi, "agent_end", {}, ownerContext())).toBeUndefined();
		expect(starts).toHaveLength(0);
	});

	test("records a failed spawn attempt", () => {
		const scheduler = {
			onOwnerEnd() {
				throw new Error("owner receipt missing");
			},
		};
		const batch = { batchId: "b1", toolCallId: "call-1", retired: true };
		const { pi } = harness({ scheduler, batch });

		expect(emit(pi, "agent_end", {}, ownerContext())).toBeUndefined();
		const records = diagnosticsSnapshot().filter((entry) => entry.domain === "hooks");
		expect(records).toHaveLength(1);
		expect(records[0].detail).toEqual({ fission: "b1", spawn: true });
	});
});

describe("fission stop guard", () => {
	test("keeps the owner's stop open while the batch is live", () => {
		const scheduler = { batchStatus: () => ({ status: "running" }) };
		const batch = { batchId: "b1", toolCallId: "call-1", retired: true };
		const { pi, station } = harness({ scheduler, batch });

		const feedback = emit(pi, "session_stop", {}, ownerContext());

		expect(feedback.continue).toBe(true);
		expect(feedback.additionalContext).toContain("Fission batch b1 is still running");
		expect(station.stopCalls).toBe(0);
		expect(station.pendingFission).toBe(batch);
	});

	test("clears a spent batch and lets the normal stop gate decide", () => {
		for (const status of ["closed", "failed", "cancelled", "cost-capped", null]) {
			const scheduler = { batchStatus: () => (status === null ? null : { status }) };
			const batch = { batchId: "b1", toolCallId: "call-1", retired: true };
			const { pi, station } = harness({ scheduler, batch });

			const feedback = emit(pi, "session_stop", {}, ownerContext());

			expect(feedback).toBe("stopped");
			expect(station.stopCalls).toBe(1);
			expect(station.pendingFission).toBeNull();
		}
	});

	test("falls back to the process-wide probe when no per-batch status exists", () => {
		const runningBatch = { batchId: "b1", toolCallId: "call-1", retired: true };
		const running = harness({
			scheduler: { hasRunningFlows: (batchId) => batchId === "b1" },
			batch: runningBatch,
		});

		const feedback = emit(running.pi, "session_stop", {}, ownerContext());

		expect(feedback.continue).toBe(true);
		expect(running.station.stopCalls).toBe(0);
		expect(running.station.pendingFission).toBe(runningBatch);

		const spentBatch = { batchId: "b2", toolCallId: "call-2", retired: true };
		const spent = harness({
			scheduler: { hasRunningFlows: () => false },
			batch: spentBatch,
		});

		expect(emit(spent.pi, "session_stop", {}, ownerContext())).toBe("stopped");
		expect(spent.station.stopCalls).toBe(1);
		expect(spent.station.pendingFission).toBeNull();
	});

	test("lets the scheduler override the stop guard", () => {
		const scheduler = {
			onOwnerStop: () => ({ continue: false }),
			batchStatus: () => ({ status: "running" }),
		};
		const batch = { batchId: "b1", toolCallId: "call-1", retired: true };
		const { pi, station } = harness({ scheduler, batch });

		const feedback = emit(pi, "session_stop", {}, ownerContext());

		expect(feedback).toEqual({ continue: false });
		expect(station.stopCalls).toBe(0);
		expect(station.pendingFission).toBe(batch);
	});

	test("does not intercept a flow's stop", () => {
		const scheduler = { batchStatus: () => ({ status: "running" }) };
		const batch = { batchId: "b1", toolCallId: "call-1", retired: true };
		const { pi, station } = harness({ scheduler, batch, fissionFlow: { id: "flow-a" } });

		expect(emit(pi, "session_stop", {}, ownerContext())).toBe("stopped");
		expect(station.stopCalls).toBe(1);
		expect(station.pendingFission).toBe(batch);
	});

	test("keeps the stop open when no scheduler is attached at all", () => {
		const batch = { batchId: "b1", toolCallId: "call-1", retired: true };
		const { pi, station } = harness({ scheduler: null, batch });

		const feedback = emit(pi, "session_stop", {}, ownerContext());

		expect(feedback.continue).toBe(true);
		expect(station.stopCalls).toBe(0);
	});

	test("delegates immediately when no batch is pending", () => {
		const { pi, station } = harness({
			scheduler: { batchStatus: () => ({ status: "running" }) },
			batch: null,
		});

		expect(emit(pi, "session_stop", {}, ownerContext())).toBe("stopped");
		expect(station.stopCalls).toBe(1);
	});
});

describe("fission flow warning visibility", () => {
	test("keeps the failure identity in diagnostics and the text in the interface", () => {
		const recorded = [];
		const shown = [];
		const result = announceFlowWarning(
			{
				type: "flow.warning",
				batchId: "b1",
				flowId: "f1",
				broadcastId: "n1",
				code: "CARRY_OVER_INPUT_UNKNOWN",
				message: "the owner agent refused the steer",
				text: "keep me",
			},
			{
				record: (...args) => recorded.push(args),
				notify: (text, code) => shown.push({ text, code }),
			},
		);

		expect(result).toEqual({ code: "CARRY_OVER_INPUT_UNKNOWN", text: "keep me", shown: true });
		expect(recorded).toHaveLength(1);
		const [domain, message, detail] = recorded[0];
		expect(domain).toBe("fission");
		expect(message).toBe("CARRY_OVER_INPUT_UNKNOWN: the owner agent refused the steer");
		expect(detail).toMatchObject({
			seam: "flow.warning",
			batchId: "b1",
			flowId: "f1",
			broadcastId: "n1",
			chars: 7,
		});
		// Diagnostics do not copy user text when the interface already shows it.
		expect(detail.text).toBeUndefined();
		expect(shown).toEqual([{ text: "keep me", code: "CARRY_OVER_INPUT_UNKNOWN" }]);
	});

	test("carries the text into diagnostics when no interface can show it", () => {
		const recorded = [];
		announceFlowWarning(
			{
				type: "flow.warning",
				code: "CARRY_OVER_INPUT_FAILED",
				message: "gone",
				text: "recover me",
			},
			{
				record: (...args) => recorded.push(args),
				notify: () => {
					throw new Error("the notifier is broken");
				},
			},
		);
		expect(recorded[0][2].text).toBe("recover me");
	});

	test("ignores batch events that are not warnings", () => {
		const recorded = [];
		expect(
			announceFlowWarning({ type: "flow.begin" }, { record: (...args) => recorded.push(args) }),
		).toBeNull();
		expect(recorded).toEqual([]);
	});
});
