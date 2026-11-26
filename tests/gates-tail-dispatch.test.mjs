// Tail-dispatch contract for gatekeepers that dispatch async model restore
// tickets. AGENTS.md §2.1: a station performs every state transition first and
// only then calls a ticket at the function tail.

import { expect, test } from "bun:test";

import {
	onBeforeAgentStart,
	onContext,
	prepareRequest,
} from "../src/station/gates.mjs";
import { READ_ONLY_SUBAGENT, READ_WRITE_SUBAGENT } from "../src/core/policy.mjs";

const CTX = { sessionManager: { getSessionId: () => "s1", getBranch: () => [] } };

function fakeStation({ policy = READ_WRITE_SUBAGENT, recovery = false } = {}) {
	const events = [];
	let dispatchedState = null;
	const station = {
		state: {
			autopilot: false,
			relay: { generation: 0, bigStreak: 0, canStop: false, userPrompts: [], pendingRewind: null },
			modelRecovery: recovery,
			charges: {},
		},
		hostBoundaryKey: null,
		registry: undefined,
		forkOwnerId: () => null,
		policy: () => policy,
		contextMessages: () => [],
		observeActualModel() {
			events.push("commit:model");
			station.state.modelObserved = true;
		},
		takePendingModelSwitch() {
			events.push("commit:switch");
			station.state.switchTaken = true;
			return { model: "recovered" };
		},
		resetUsageWatermark() {
			events.push("commit:watermark");
		},
		persist() {
			events.push("commit:persist");
		},
		skillReceipt() {
			events.push("commit:receipt");
			station.state.receiptBuilt = true;
			return { role: "user", herdSkill: true };
		},
		tickets: {
			restoreScopedModel() {
				events.push("dispatch:restore");
				dispatchedState = { ...station.state };
				return "restore-ticket";
			},
		},
	};
	return {
		station,
		events,
		snapshot: () => dispatchedState,
	};
}

test("prepareRequest commits the model observation and the pending switch before dispatching restore", () => {
	const { station, events, snapshot } = fakeStation({ recovery: true });

	const result = prepareRequest(station, CTX, null, undefined);

	expect(result).toBe("restore-ticket");
	expect(events).toEqual([
		"commit:model",
		"commit:switch",
		"dispatch:restore",
	]);
	expect(snapshot()).toMatchObject({ modelObserved: true, switchTaken: true });
});

test("prepareRequest returns the receipt synchronously when no restore is due", () => {
	const { station, events } = fakeStation();

	const result = prepareRequest(station, CTX, null, undefined);

	expect(result).toMatchObject({ role: "user", herdSkill: true });
	expect(events).toEqual([
		"commit:model",
		"commit:receipt",
	]);
});

test("onBeforeAgentStart commits the model observation and the pending switch before dispatching restore", () => {
	const { station, events, snapshot } = fakeStation({ recovery: true });

	const result = onBeforeAgentStart(
		station,
		{ systemPrompt: "base prompt" },
		CTX,
	);

	expect(result).toBe("restore-ticket");
	expect(events).toEqual([
		"commit:model",
		"commit:switch",
		"dispatch:restore",
	]);
	expect(snapshot()).toMatchObject({ modelObserved: true, switchTaken: true });
});

test("a read-only session never reaches the restore ticket", () => {
	const { station, events } = fakeStation({
		policy: READ_ONLY_SUBAGENT,
		recovery: true,
	});

	const prepared = prepareRequest(station, CTX, null, undefined);
	const started = onBeforeAgentStart(station, { systemPrompt: "base" }, CTX);

	expect(prepared).toBeNull();
	expect(started?.systemPrompt).toContain("herdchestra-lite2:system-prompt");
	expect(events).toEqual([]);
});

test("a read-only session passes its history through untouched", () => {
	const messages = [{ role: "user", content: "hello", timestamp: 2 }];
	const station = {
		policy: () => READ_ONLY_SUBAGENT,
		transformContext() {
			throw new Error("read-only requests bypass the projection");
		},
	};

	const result = onContext(station, messages, CTX);

	// A read-only subagent owns no scope state, so the projection must never
	// run for it; its history reaches the host exactly as it arrived.
	expect(result.messages).toBe(messages);
});
