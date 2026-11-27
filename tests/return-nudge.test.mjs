// A forked scope that stops naturally submits nothing: only `scope_return`
// closes its bracket. Two legs keep it working. The station steers an
// assistant message that ends without a tool call while the child's own
// record is still running; the session-stop gate asks again when the host
// drops that steer. Both draw on the record's one return allowance, which the
// spawn ticket also spends.

import { describe, expect, test } from "bun:test";

import {
	createBracketLedger,
	forkOf,
	markReady,
	registerFork,
	unreceivedChildren,
} from "../src/scope/index.mjs";
import {
	childReturnNudge,
	MAX_RETURN_NUDGES,
	resetReturnNudges,
	returnNudgesOf,
	takeReturnNudge,
} from "../src/scope/return-nudge.mjs";
import { onAssistantMessage, onSessionStop } from "../src/station/gates.mjs";
import { nudgeDecision } from "../src/station/nudge.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { READ_WRITE_SUBAGENT } from "../src/core/policy.mjs";
import { createTestStation } from "./helpers/station-ports.mjs";
import { createState, planLedgerEntry, foldStateChain } from "../src/scope/index.mjs";

function childLedger() {
	const ledger = createBracketLedger();
	registerFork(ledger, {
		forkId: "fork_a",
		ownerId: "root",
		levelKey: "root|0|0",
		fsm: "child work",
		depth: 0,
	});
	return ledger;
}

function withGrandchild(ledger) {
	registerFork(ledger, {
		forkId: "fork_b",
		ownerId: "fork_a",
		levelKey: "fork_a|0|0",
		fsm: "grandchild work",
		depth: 1,
	});
	return ledger;
}

function assistant(text = "done") {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function nudgeStation(ledger, ownerId) {
	const station = Object.create(SessionStation.prototype);
	station.state = { features: { autopilot: "off" }, relay: { canStop: false, pendingRewind: null } };
	station.nudged = new WeakSet();
	station.delivered = [];
	station.forkLedgerPort = () => ledger;
	station.forkOwnerId = () => ownerId;
	station.deliverSteer = (text) => station.delivered.push(text) > 0;
	return station;
}

function stopStation(ownerId, ledger) {
	return {
		state: { features: { autopilot: "off" }, relay: { canStop: false, pendingRewind: null } },
		forkOwnerId: () => ownerId,
		forkLedgerPort: () => ledger,
		// The stop gate reads two facts from the projection: the mode, and how
		// many children this scope still owes a receive. A stub that answered
		// only the mode would make every child look childless and let the
		// return nudge outrank a pending join.
		projectionFor: () => ({
			mode: ownerId === null ? "ROOT_AUTOPILOT" : "CHILD",
			state: { unreceived: unreceivedChildren(ledger, ownerId ?? "root").length },
		}),
	};
}

describe("nudgeDecision", () => {
	test("a forked scope still running is told to return", () => {
		const decision = nudgeDecision({
			hasToolCalls: false,
			ledger: childLedger(),
			ownerId: "fork_a",
		});

		expect(decision.kind).toBe("steer");
		expect(decision.charge).toBe("return");
		expect(decision.text).toBe(childReturnNudge());
		expect(decision.text).toContain("scope_return");
	});

	test("a forked scope that already returned earns none", () => {
		const ledger = childLedger();
		markReady(ledger, "fork_a", { ok: true, record: "the child's own record" });

		expect(
			nudgeDecision({ hasToolCalls: false, ledger, ownerId: "fork_a" }),
		).toEqual({ kind: "none" });
	});

	test("a failed bracket stops the nudge, which is how the ticket's bound lands", () => {
		const ledger = childLedger();
		markReady(ledger, "fork_a", { ok: false, reason: "stopped without scope_return" });

		expect(
			nudgeDecision({ hasToolCalls: false, ledger, ownerId: "fork_a" }),
		).toEqual({ kind: "none" });
	});

	test("the root earns a join steer with open children, a return steer under autopilot, and none in manual duty", () => {
		const ledger = childLedger();

		// The root has a running child; that is the receive obligation.
		expect(
			nudgeDecision({ hasToolCalls: false, ledger })?.text,
		).toContain("scope_join");

		// Manual duty: root may stop naturally.
		expect(
			nudgeDecision({ hasToolCalls: false, ledger: createBracketLedger(), mode: "ROOT_MANUAL" }),
		).toEqual({ kind: "none" });

		// Autopilot without canStop: root must call scope_return.
		const auto = nudgeDecision({
			hasToolCalls: false,
			ledger: createBracketLedger(),
			mode: "ROOT_AUTOPILOT",
			relay: { canStop: false, pendingRewind: null },
		});
		expect(auto.kind).toBe("steer");
		expect(auto.text).toContain("scope_return");

		// Autopilot after two consecutive oaths: root may stop naturally.
		expect(
			nudgeDecision({
				hasToolCalls: false,
				ledger: createBracketLedger(),
				mode: "ROOT_AUTOPILOT",
				relay: { canStop: true, pendingRewind: null },
			}),
		).toEqual({ kind: "none" });
	});

	test("a tool-call beat, a missing record, or no ledger earns none", () => {
		expect(
			nudgeDecision({
				hasToolCalls: true,
				ledger: childLedger(),
				ownerId: "fork_a",
			}),
		).toEqual({ kind: "none" });
		expect(
			nudgeDecision({ hasToolCalls: false, ledger: childLedger(), ownerId: "fork_z" }),
		).toEqual({ kind: "none" });
		expect(
			nudgeDecision({ hasToolCalls: false, ledger: null, ownerId: "fork_a" }),
		).toEqual({ kind: "none" });
	});

	test("an unreceived grandchild outranks the return steer", () => {
		const decision = nudgeDecision({
			hasToolCalls: false,
			ledger: withGrandchild(childLedger()),
			ownerId: "fork_a",
		});

		expect(decision.kind).toBe("steer");
		expect(decision.text).toContain("scope_join");
		expect(decision.text).not.toBe(childReturnNudge());
	});

	test("a parent that returned still earns the join steer for its own child", () => {
		const ledger = withGrandchild(childLedger());
		markReady(ledger, "fork_a", { ok: true, record: "the child's own record" });

		const decision = nudgeDecision({
			hasToolCalls: false,
			ledger,
			ownerId: "fork_a",
		});

		expect(decision.text).toContain("scope_join");
	});
});

describe("the shared return allowance", () => {
	test("a fresh record starts with none spent", () => {
		const record = forkOf(childLedger(), "fork_a");

		expect(record.returnNudges).toBe(0);
		expect(returnNudgesOf(record)).toBe(0);
	});

	test("the return allowance survives a ledger persistence round trip", () => {
		const state = createState();
		state.brackets = childLedger();
		const first = planLedgerEntry(state, null);
		const record = forkOf(state.brackets, "fork_a");
		expect(takeReturnNudge(record)).toBe(true);
		const next = planLedgerEntry(state, first.brackets);
		expect(next.entry).not.toBeNull();
		const restored = foldStateChain([first.entry, next.entry]);
		expect(restored.brackets.forks.fork_a.returnNudges).toBe(1);
	});

	test("the station's leg and the ticket's leg spend the same counter", () => {
		const record = forkOf(childLedger(), "fork_a");

		expect(takeReturnNudge(record)).toBe(true);
		expect(takeReturnNudge(record)).toBe(true);
		expect(takeReturnNudge(record)).toBe(false);
		expect(returnNudgesOf(record)).toBe(MAX_RETURN_NUDGES);
	});

	test("a spent allowance silences the assistant-message steer", () => {
		const ledger = childLedger();
		forkOf(ledger, "fork_a").returnNudges = MAX_RETURN_NUDGES;

		expect(
			nudgeDecision({ hasToolCalls: false, ledger, ownerId: "fork_a" }),
		).toEqual({ kind: "none" });
	});

	test("each delivered steer spends one of them", () => {
		const ledger = childLedger();
		const station = nudgeStation(ledger, "fork_a");

		station.maybeNudge(assistant("one"), {});
		station.maybeNudge(assistant("two"), {});
		station.maybeNudge(assistant("three"), {});

		expect(station.delivered).toEqual([childReturnNudge(), childReturnNudge()]);
		expect(returnNudgesOf(forkOf(ledger, "fork_a"))).toBe(MAX_RETURN_NUDGES);
	});

	test("a steer the host refuses costs nothing and leaves the message unserved", () => {
		const ledger = childLedger();
		const station = nudgeStation(ledger, "fork_a");
		station.deliverSteer = () => false;
		const message = assistant();

		station.maybeNudge(message, {});

		expect(station.delivered).toEqual([]);
		expect(returnNudgesOf(forkOf(ledger, "fork_a"))).toBe(0);
		expect(station.nudged.has(message)).toBe(false);
	});

	test("a new requirement restarts the allowance", () => {
		const record = forkOf(childLedger(), "fork_a");
		takeReturnNudge(record);
		takeReturnNudge(record);

		resetReturnNudges(record);

		expect(returnNudgesOf(record)).toBe(0);
		expect(takeReturnNudge(record)).toBe(true);
	});

	test("a snapshot written before the field reads as zero", () => {
		const record = forkOf(childLedger(), "fork_a");
		delete record.returnNudges;

		expect(returnNudgesOf(record)).toBe(0);
		expect(takeReturnNudge(record)).toBe(true);
	});
});

describe("the session-stop backstop", () => {
	test("a child that stopped short is asked to return, even in manual duty", () => {
		const ledger = childLedger();
		const out = onSessionStop(stopStation("fork_a", ledger), {}, null);

		expect(out?.continue).toBe(true);
		expect(out.additionalContext).toBe(childReturnNudge());
		expect(returnNudgesOf(forkOf(ledger, "fork_a"))).toBe(1);
	});

	test("the backstop stops at the shared bound", () => {
		const ledger = childLedger();
		const station = stopStation("fork_a", ledger);

		expect(onSessionStop(station, {}, null)?.continue).toBe(true);
		expect(onSessionStop(station, {}, null)?.continue).toBe(true);
		expect(onSessionStop(station, {}, null)).toBeUndefined();
	});

	test("a returned child is not steered at the stop", () => {
		const ledger = childLedger();
		markReady(ledger, "fork_a", { ok: true, record: "the child's own record" });

		expect(onSessionStop(stopStation("fork_a", ledger), {}, null)).toBeUndefined();
		expect(returnNudgesOf(forkOf(ledger, "fork_a"))).toBe(0);
	});

	test("the join steer still outranks the backstop and spends nothing", () => {
		const ledger = withGrandchild(childLedger());
		const out = onSessionStop(stopStation("fork_a", ledger), {}, null);

		expect(out.additionalContext).toContain("scope_join");
		expect(returnNudgesOf(forkOf(ledger, "fork_a"))).toBe(0);
	});

	test("the root owns no return obligation", () => {
		expect(
			onSessionStop(stopStation(null, createBracketLedger()), {}, null),
		).toBeUndefined();
	});
});

describe("SessionStation.maybeNudge", () => {
	test("a child's natural stop delivers the return steer once", () => {
		const station = nudgeStation(childLedger(), "fork_a");
		const message = assistant();

		station.maybeNudge(message, {});
		station.maybeNudge(message, {});

		expect(station.delivered).toEqual([childReturnNudge()]);
	});

	test("a child that already returned delivers nothing", () => {
		const ledger = childLedger();
		markReady(ledger, "fork_a", { ok: true, record: "the child's own record" });
		const station = nudgeStation(ledger, "fork_a");

		station.maybeNudge(assistant(), {});

		expect(station.delivered).toEqual([]);
	});

	test("the root's natural stop is not given a return steer", () => {
		const station = nudgeStation(createBracketLedger(), null);

		station.maybeNudge(assistant(), {});

		expect(station.delivered).toEqual([]);
	});
});

// The gate is the seam production crosses: host event -> onAssistantMessage ->
// policy -> toolCalls(message) -> maybeNudge -> deliverSteer -> tickets.steer.
// A double built by hand around `maybeNudge` proves only that the decision is
// callable; this block proves the wiring still reaches it.
function gateStation(ledger, ownerId) {
	const delivered = [];
	const tickets = {
		canSteer: true,
		steer: (text) => {
			delivered.push(text);
		},
	};
	const station = createTestStation(
		SessionStation,
		{ getSessionId: () => "gate-session" },
		{},
		tickets,
		undefined,
		undefined,
	);
	station.forkLedgerPort = () => ledger;
	station.forkOwnerId = () => ownerId;
	return { station, delivered };
}

describe("onAssistantMessage gate", () => {
	test("a forked child's stop reaches the steer through the real gate", () => {
		const ledger = childLedger();
		const { station, delivered } = gateStation(ledger, "fork_a");

		// The bound fork identity is what keeps the read-only early return out
		// of the way, so assert the gate's own verdict, not a stubbed one.
		expect(station.policy({})).toBe(READ_WRITE_SUBAGENT);

		onAssistantMessage(station, assistant(), {});

		expect(delivered).toEqual([childReturnNudge()]);
		expect(returnNudgesOf(forkOf(ledger, "fork_a"))).toBe(1);
	});

	test("one assistant message is steered once through the gate", () => {
		const ledger = childLedger();
		const { station, delivered } = gateStation(ledger, "fork_a");
		const message = assistant();

		onAssistantMessage(station, message, {});
		onAssistantMessage(station, message, {});

		expect(delivered).toEqual([childReturnNudge()]);
		expect(returnNudgesOf(forkOf(ledger, "fork_a"))).toBe(1);
	});

	test("the gate reads the tool call out of the message, not a flag", () => {
		const ledger = childLedger();
		const { station, delivered } = gateStation(ledger, "fork_a");
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
		};

		onAssistantMessage(station, message, {});

		expect(delivered).toEqual([]);
		expect(returnNudgesOf(forkOf(ledger, "fork_a"))).toBe(0);
	});
});
