import { describe, expect, test } from "bun:test";

import { wireHooks } from "../src/activation/hooks.mjs";
import { handleScopeCall } from "../src/station/controls.mjs";
import { onToolCall } from "../src/station/gates.mjs";
import {
	clearOwnerRetired,
	markOwnerRetired,
	ownerRetirement,
	retiredOwnerReason,
} from "../src/station/retirement.mjs";

const BEGIN = {
	stage: "acceptance-cases",
	elder_report: null,
	fission: [{ intent: "inner", budget: { read: 1 }, permission: "ro" }],
};

/** A station whose owner opened batch b1 and already retired from it. */
function retiredStation(batchId = "b1", ownerId = "owner-a") {
	const station = {
		state: {},
		pendingFission: { batchId, toolCallId: "call-open", retired: true },
	};
	markOwnerRetired(station, {
		batchId,
		toolCallId: "call-open",
		identity: { id: ownerId },
	});
	return station;
}

function fakePi() {
	const handlers = new Map();
	return {
		handlers,
		on(event, handler) {
			handlers.set(event, handler);
		},
	};
}

function fakeStation(batch) {
	const station = {
		pendingFission: batch,
		marked: [],
		markOwnerRetired(request) {
			station.marked.push(request);
		},
		onAssistantMessage() {},
		onMessageEnd() {},
		onUsageMessage() {},
		onToolCall() {},
		onBeforeAgentStart() {},
		onSessionStop() {},
		onSessionSwitch() {},
		onSessionCompact() {},
	};
	return station;
}

function fakeRegistry(station) {
	return {
		stationFor: () => station,
		stationForStop: () => station,
		fissionScheduler: () => ({ retireOwner: () => ({ ok: true, abort: false }) }),
	};
}

describe("retired owner identity record", () => {
	test("records the explicit identity that retired", () => {
		const station = {};
		const record = markOwnerRetired(station, {
			batchId: "b1",
			toolCallId: "call-open",
			identity: { kind: "flow", id: "flow-a" },
		});

		expect(record).toEqual({
			batchId: "b1",
			toolCallId: "call-open",
			identityId: "flow-a",
		});
		expect(station.ownerRetired).toBe(record);
	});

	test("refuses the retired identity and admits the heir on the same station", () => {
		const station = retiredStation();

		expect(ownerRetirement(station, { agent: { id: "owner-a" } })).toEqual({
			code: "OWNER_RETIRED",
			batchId: "b1",
			reason: retiredOwnerReason("b1"),
		});
		// A different identity is the adopted heir or a successor generation,
		// never the owner that retired.
		expect(ownerRetirement(station, { agent: { id: "heir-a" } })).toBeNull();
	});

	test("keeps an identity-less context blocked only while the batch is live", () => {
		const station = retiredStation();

		expect(ownerRetirement(station, {})?.code).toBe("OWNER_RETIRED");
		// The batch resolved and cleared its descriptor: post-inheritance
		// interaction is no longer refused.
		station.pendingFission = null;
		expect(ownerRetirement(station, {})).toBeNull();
	});

	test("clears only the matching batch and restores interaction", () => {
		const station = retiredStation();

		expect(clearOwnerRetired(station, "b2")).toBe(false);
		expect(station.ownerRetired?.batchId).toBe("b1");
		expect(clearOwnerRetired(station, "b1")).toBe(true);
		expect(station.ownerRetired).toBeNull();
		expect(ownerRetirement(station, { agent: { id: "owner-a" } })).toBeNull();
	});
});

describe("retired owner tool gate", () => {
	test("blocks every later tool call from the retired owner", () => {
		const station = retiredStation();
		const ctx = { agent: { id: "owner-a" } };

		for (const [toolName, input] of [
			["read", {}],
			["bash", { command: "true" }],
			["scope", { begin: BEGIN }],
		]) {
			const verdict = onToolCall(
				station,
				{ toolName, toolCallId: `call-${toolName}`, input },
				ctx,
			);
			expect(verdict).toEqual({ block: true, reason: retiredOwnerReason("b1") });
		}
	});

	test("blocks deferred dispatch admission too", () => {
		const verdict = onToolCall(
			retiredStation(),
			{ toolName: "scope", toolCallId: "call-admitted" },
			{ agent: { id: "owner-a" } },
			true,
		);

		expect(verdict?.block).toBe(true);
		expect(verdict.reason).toContain("OWNER_RETIRED");
	});
});

describe("retirement fired from the owner's own tool result", () => {
	test("marks the station before the abort and stays idempotent", () => {
		const batch = { batchId: "b1", toolCallId: "call-open", retired: false };
		const station = fakeStation(batch);
		const pi = fakePi();
		wireHooks(pi, fakeRegistry(station));
		const ctx = {
			agent: { id: "owner-a" },
			aborts: 0,
			abort() {
				this.aborts += 1;
			},
		};

		pi.handlers.get("tool_result")({ toolCallId: "call-open" }, ctx);

		expect(batch.retired).toBe(true);
		expect(station.marked).toEqual([
			{ batchId: "b1", toolCallId: "call-open", identity: ctx.agent },
		]);
		// The scheduler used its narrow abort; the hook must not add a second.
		expect(ctx.aborts).toBe(0);

		pi.handlers.get("tool_result")({ toolCallId: "call-open" }, ctx);
		expect(station.marked).toHaveLength(1);
	});
});

describe("retired owner scope begin", () => {
	function beginCall(station, ctx) {
		return handleScopeCall(
			station,
			{ id: "call-second", name: "scope", arguments: { begin: BEGIN } },
			{
				base: [],
				currentMessage: { role: "assistant", content: [] },
				currentPersisted: false,
				sameMessageBeginIds: new Set(),
				ctx,
			},
		);
	}

	test("refuses a second fission batch from the retired owner", () => {
		const result = beginCall(retiredStation(), { agent: { id: "owner-a" } });

		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("OWNER_RETIRED");
	});

	test("refuses the retired pending descriptor without a recorded identity", () => {
		const station = {
			state: {},
			pendingFission: { batchId: "b9", toolCallId: "call-open", retired: true },
		};
		const result = beginCall(station, {});

		expect(result.isError).toBe(true);
		expect(result.details.code).toBe("OWNER_RETIRED");
	});
});
