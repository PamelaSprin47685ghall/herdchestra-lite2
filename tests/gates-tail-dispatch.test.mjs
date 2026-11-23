// Tail-dispatch contract for the two gatekeepers that grant `todo`.
//
// AGENTS.md §2.1: a station performs every state transition and only then
// calls a ticket at the function tail, because an async ticket's synchronous
// prefix runs immediately on call and would otherwise observe half-updated
// state. These tests make the ticket itself record what it saw when it was
// dispatched, so the proof is behavioral: the snapshot must already contain
// the model observation, the pending model switch, and the receipt commit.

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
	let ensureToolsCalls = 0;
	const station = {
		state: {
			autopilot: false,
			relay: {},
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
			return { role: "developer", herdSkill: true };
		},
		ensureTools() {
			ensureToolsCalls += 1;
			events.push("dispatch:ensureTools");
			dispatchedState = { ...station.state };
		},
		tickets: {
			restoreScopedModel() {
				events.push("dispatch:restore");
				return "restore-ticket";
			},
		},
	};
	return {
		station,
		events,
		snapshot: () => dispatchedState,
		ensureToolsCalls: () => ensureToolsCalls,
	};
}

test("prepareRequest commits the model observation and the pending switch before granting todo", () => {
	const { station, events, snapshot, ensureToolsCalls } = fakeStation({ recovery: true });

	const result = prepareRequest(station, CTX, null, undefined);

	expect(result).toBe("restore-ticket");
	expect(ensureToolsCalls()).toBe(1);
	expect(events).toEqual([
		"commit:model",
		"commit:switch",
		"dispatch:ensureTools",
		"dispatch:restore",
	]);
	expect(snapshot()).toMatchObject({ modelObserved: true, switchTaken: true });
});

test("prepareRequest commits the receipt before granting todo when no restore is due", () => {
	const { station, events, snapshot, ensureToolsCalls } = fakeStation();

	const result = prepareRequest(station, CTX, null, undefined);

	expect(result).toMatchObject({ role: "developer", herdSkill: true });
	expect(ensureToolsCalls()).toBe(1);
	expect(events).toEqual([
		"commit:model",
		"commit:receipt",
		"dispatch:ensureTools",
	]);
	expect(snapshot()).toMatchObject({ modelObserved: true, receiptBuilt: true });
});

test("onBeforeAgentStart commits the model observation and the pending switch before granting todo", () => {
	const { station, events, snapshot, ensureToolsCalls } = fakeStation({ recovery: true });

	const result = onBeforeAgentStart(
		station,
		{ systemPrompt: "base prompt" },
		CTX,
	);

	expect(result).toBe("restore-ticket");
	expect(ensureToolsCalls()).toBe(1);
	expect(events).toEqual([
		"commit:model",
		"commit:switch",
		"dispatch:ensureTools",
		"dispatch:restore",
	]);
	expect(snapshot()).toMatchObject({ modelObserved: true, switchTaken: true });
});

test("a read-only session never reaches the granting ticket", () => {
	const { station, events, ensureToolsCalls } = fakeStation({
		policy: READ_ONLY_SUBAGENT,
		recovery: true,
	});

	const prepared = prepareRequest(station, CTX, null, undefined);
	const started = onBeforeAgentStart(station, { systemPrompt: "base" }, CTX);

	expect(prepared).toBeNull();
	// The prompt injection still runs; only the tickets must stay uncreated.
	expect(started?.systemPrompt).toContain("herdchestra-lite2:system-prompt");
	expect(ensureToolsCalls()).toBe(0);
	expect(events).toEqual([]);
});

test("a read-only session still carries the shared first turn", () => {
	const messages = [{ role: "user", content: "hello", timestamp: 2 }];
	const station = {
		policy: () => READ_ONLY_SUBAGENT,
		transformContext() {
			throw new Error("read-only requests bypass the projection");
		},
	};

	const result = onContext(
		station,
		messages,
		CTX,
		[{ role: "user", content: [{ type: "text", text: "shared snapshot" }] }],
	);

	expect(result.messages[0]).toEqual({
		role: "user",
		content: [{ type: "text", text: "shared snapshot" }],
		timestamp: 1,
		attribution: "user",
	});
	expect(result.messages[1]).toBe(messages[0]);
	expect(onContext(station, messages, CTX).messages).toBe(messages);
});
