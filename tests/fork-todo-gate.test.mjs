// The todo tool stays available at every branch level, including a root that
// still owns an unreceived child. The receive obligation no longer withholds
// the tool; it withholds the relay: an empty ledger cannot advance while a
// child result is in flight.

import { describe, expect, test } from "bun:test";

import { onToolCall } from "../src/station/gates.mjs";
import { recordLedgerEvaluation } from "../src/station/handoff-state.mjs";
import { createRelay } from "../src/relay/index.mjs";
import { createBracketLedger, markReady, registerFork } from "../src/scope/index.mjs";

function stationWith(children, { ownerId = "root", viewer = null } = {}) {
	const ledger = createBracketLedger();
	for (const forkId of children) {
		registerFork(ledger, {
			forkId,
			ownerId,
			levelKey: `${ownerId}|0|0`,
			intent: `child ${forkId}`,
			depth: 0,
			blocked: false,
		});
	}
	return {
		state: { scopes: [], relay: null, herdMode: false },
		processed: { hasHandled: () => true, markCall: () => {} },
		processControlsForTool: () => {},
		forkLedgerPort: () => ledger,
		forkOwnerId: () => viewer,
		persist: () => {},
		policy: () => "main",
		relayOn: () => false,
		registry: { ports: () => ({}) },
	};
}

function todoEvent() {
	return {
		toolName: "todo",
		toolCallId: "call_todo",
		input: { op: "init", list: [] },
	};
}

/** A root station with a real relay, for the transition the guard holds. */
function relayStation(children, { ownerId = "root", viewer = null, ready = [] } = {}) {
	const station = stationWith(children, { ownerId, viewer });
	station.state.relay = createRelay();
	for (const forkId of ready) {
		expect(markReady(station.forkLedgerPort(), forkId, { ok: true }).ok).toBe(true);
	}
	return station;
}

describe("todo with unreceived fork results", () => {
	test("does not refuse the tool while a fork has not been received", () => {
		const station = stationWith(["fork_a"]);
		const verdict = onToolCall(station, todoEvent(), {});
		expect(verdict).toBeUndefined();
	});

	test("allows the ledger once every child is received", () => {
		const station = stationWith([]);
		const verdict = onToolCall(station, todoEvent(), {});
		expect(verdict).toBeUndefined();
	});

	test("allows a child's todo even while that child owns an unreceived grandchild", () => {
		// Only the root write can arm a handoff. A child's write never touches
		// the relay, so its own unreceived children must not withhold the tool.
		const station = stationWith(["grand"], { ownerId: "fork_a", viewer: "fork_a" });
		const verdict = onToolCall(station, todoEvent(), {});
		expect(verdict).toBeUndefined();
	});
});

describe("an empty ledger while a child is unreceived", () => {
	test("does not advance the relay while a child is still running", () => {
		const station = relayStation(["fork_a"]);
		const before = JSON.stringify(station.state.relay);
		const applied = recordLedgerEvaluation(station, [], "init");

		expect(applied.action).toBe("held");
		expect(applied.unreceived).toBe(1);
		expect(applied.changed).toBe(false);
		expect(JSON.stringify(station.state.relay)).toBe(before);
		expect(station.state.relay.handoffPending).toBe(false);
	});

	test("does not advance the relay while a returned child is unreceived", () => {
		const station = relayStation(["fork_a"], { ready: ["fork_a"] });
		const applied = recordLedgerEvaluation(station, [], "init");

		expect(applied.action).toBe("held");
		expect(applied.unreceived).toBe(1);
		expect(station.state.relay.lastLedger).toBeNull();
	});

	test("an empty ledger with no unreceived child still arms the handoff", () => {
		const station = relayStation([]);
		const applied = recordLedgerEvaluation(station, [], "init");

		expect(applied.action).toBe("handoff");
		expect(station.state.relay.handoffPending).toBe(true);
	});

	test("a non-empty ledger still evaluates while a child is unreceived", () => {
		const station = relayStation(["fork_a"]);
		const applied = recordLedgerEvaluation(
			station,
			[{ phase: "P", items: ["still working"] }],
			"init",
		);

		expect(applied.action).toBe("rework");
		expect(station.state.relay.firstEvaluation).toBe("nonempty");
		expect(station.state.relay.lastLedger.open).toBe(1);
	});

	test("a view still changes nothing while a child is unreceived", () => {
		const station = relayStation(["fork_a"]);
		const before = { ...station.state.relay };
		const applied = recordLedgerEvaluation(station, [], "view");

		expect(applied.action).toBeNull();
		expect(station.state.relay).toEqual(before);
	});
});
