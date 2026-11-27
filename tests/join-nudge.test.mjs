// The join nudge is the one steer that outranks every relay and process rule:
// a returned child may be parked inside scope_return, and only the parent's
// take releases it. The root obeys the same rule as any other branch.

import { describe, expect, test } from "bun:test";

import { createBracketLedger, markReady, registerFork } from "../src/scope/index.mjs";
import { nudgeDecision } from "../src/station/nudge.mjs";
import { SessionStation } from "../src/station/station.mjs";

function ledgerWith(status = "running") {
	const ledger = createBracketLedger();
	registerFork(ledger, {
		forkId: "fork_a",
		ownerId: "root",
		levelKey: "root|0|0",
		fsm: "child work",
		depth: 0,
	});
	if (status === "ready") markReady(ledger, "fork_a", { ok: true });
	return ledger;
}

function assistant(text = "done") {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function nudgeStation(ledger, ownerId = null) {
	const station = Object.create(SessionStation.prototype);
	station.state = { features: { autopilot: "on" } };
	station.nudged = new WeakSet();
	station.delivered = [];
	station.relayOn = () => false;
	station.forkLedgerPort = () => ledger;
	station.forkOwnerId = () => ownerId;
	station.deliverSteer = (text) => station.delivered.push(text);
	return station;
}

describe("nudgeDecision", () => {
	test("a running or a returned child earns the join steer", () => {
		for (const status of ["running", "ready"]) {
			const decision = nudgeDecision({
				hasToolCalls: false,
				ledger: ledgerWith(status),
			});
			expect(decision.kind).toBe("steer");
			expect(decision.text).toContain("1 unreceived result(s) from forked scopes");
			expect(decision.text).toContain("scope_join");
		}
	});

	test("a child's own unreceived work earns the same steer", () => {
		const ledger = createBracketLedger();
		registerFork(ledger, {
			forkId: "fork_a",
			ownerId: "root",
			levelKey: "root|0|0",
			fsm: "parent work",
			depth: 0,
		});
		registerFork(ledger, {
			forkId: "fork_b",
			ownerId: "fork_a",
			levelKey: "fork_a|0|0",
			fsm: "grandchild work",
			depth: 1,
		});
		const decision = nudgeDecision({
			hasToolCalls: false,
			ledger,
			ownerId: "fork_a",
		});
		expect(decision.kind).toBe("steer");
	});

	test("all joined, a superseded result, no ledger, or a tool-call beat earns none", () => {
		expect(
			nudgeDecision({ hasToolCalls: false, ledger: createBracketLedger() }),
		).toEqual({ kind: "none" });
		expect(nudgeDecision({ hasToolCalls: false })).toEqual({ kind: "none" });
		expect(
			nudgeDecision({ hasToolCalls: true, ledger: ledgerWith("running") }),
		).toEqual({ kind: "none" });

		const superseded = ledgerWith("ready");
		superseded.forks.fork_a.supersededAt = 1;
		expect(
			nudgeDecision({ hasToolCalls: false, ledger: superseded }),
		).toEqual({ kind: "none" });
	});
});

describe("SessionStation.maybeNudge", () => {
	test("the root earns a join steer even with its relay off", () => {
		const station = nudgeStation(ledgerWith("running"));
		const message = assistant();

		station.maybeNudge(message, {});

		expect(station.delivered).toHaveLength(1);
		expect(station.delivered[0]).toContain("scope_join");
	});

	test("delivery happens once per assistant message", () => {
		const station = nudgeStation(ledgerWith("ready"));
		const message = assistant();

		station.maybeNudge(message, {});
		station.maybeNudge(message, {});

		expect(station.delivered).toHaveLength(1);
	});

	test("a beat with a tool call earns no steer", () => {
		const station = nudgeStation(ledgerWith("running"));
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
		};

		station.maybeNudge(message, {});

		expect(station.delivered).toEqual([]);
	});

	test("the steer is not withheld when the relay is unavailable", () => {
		const station = nudgeStation(ledgerWith("running"));
		station.relayOn = () => false;
		station.state.features.autopilot = "off";

		station.maybeNudge(assistant(), {});

		expect(station.delivered).toHaveLength(1);
	});
});
