import { describe, expect, test } from "bun:test";

import { copyRelay, createRelay } from "../src/relay/index.mjs";
import { nudgeDecision } from "../src/station/nudge.mjs";

function stateWithRelay(relay) {
	return { autopilot: true, relay };
}

const outside = { hasToolCalls: false };

describe("outside-scope nudges exist only where a stop would erase written work", () => {
	test("no ledger on record: the stop is an empty evaluation, not a violation", () => {
		expect(nudgeDecision(stateWithRelay(createRelay()), outside)).toEqual({
			kind: "none",
		});
	});

	test("a legacy snapshot without fullFlow is judged by the same rule", () => {
		// The old reader short-circuited on the switch itself. The ledger is the
		// only authority now, so a snapshot that names just a generation owes
		// exactly what a fresh relay owes: nothing.
		expect(nudgeDecision(stateWithRelay({ generation: 1 }), outside)).toEqual({
			kind: "none",
		});
	});

	test("a ledger on record is decided by the stop gate, never by a steer", () => {
		const ledger = copyRelay({ lastLedger: { empty: false } }).lastLedger;
		expect(ledger).not.toBeNull();
		const decision = nudgeDecision(stateWithRelay({ lastLedger: ledger }), outside);
		expect(decision).toEqual({ kind: "none" });
	});

	test("a promoted holder is not nudged by a stale ledger", () => {
		const ledger = copyRelay({ lastLedger: { empty: false } }).lastLedger;
		const decision = nudgeDecision(
			stateWithRelay({ canStop: true, lastLedger: ledger }),
			outside,
		);
		expect(decision).toEqual({ kind: "none" });
	});

	test("an empty ledger and a pending handoff are decided by the stop gate", () => {
		const ledger = copyRelay({ lastLedger: { empty: true } }).lastLedger;
		expect(
			nudgeDecision(stateWithRelay({ lastLedger: ledger }), outside),
		).toEqual({ kind: "none" });
		expect(
			nudgeDecision(
				stateWithRelay({ handoffPending: true, lastLedger: ledger }),
				outside,
			),
		).toEqual({ kind: "none" });
	});
});
