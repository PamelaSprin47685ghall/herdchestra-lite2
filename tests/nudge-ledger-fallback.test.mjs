import { describe, expect, test } from "bun:test";

import { copyRelay } from "../src/relay/index.mjs";
import { nudgeDecision } from "../src/station/nudge.mjs";

function stateWithRelay(relay) {
	return { herdMode: false, relay };
}

const outside = { hasToolCalls: false, hasHandoffReport: false };

describe("outside-scope nudge derives the flow from a legacy relay", () => {
	test("a legacy snapshot that started a generation is still nudged", () => {
		// No `fullFlow` field at all: only a generation. The old reader treated
		// this as outside the full flow and stopped nudging for good.
		const decision = nudgeDecision(stateWithRelay({ generation: 1 }), outside);
		expect(decision.kind).toBe("steer");
		expect(decision.text.length).toBeGreaterThan(0);
	});

	test("a ledger on record forbids a silent stop even without the switch", () => {
		const ledger = copyRelay({ lastLedger: { empty: false } }).lastLedger;
		expect(ledger).not.toBeNull();
		const decision = nudgeDecision(stateWithRelay({ lastLedger: ledger }), outside);
		expect(decision.kind).toBe("steer");
		expect(decision.text.length).toBeGreaterThan(0);
	});

	test("a promoted holder is not nudged by a stale ledger", () => {
		const ledger = copyRelay({ lastLedger: { empty: false } }).lastLedger;
		const decision = nudgeDecision(stateWithRelay({ canStop: true, lastLedger: ledger }), outside);
		expect(decision).toEqual({ kind: "none" });
	});

	test("an empty ledger still hands off inside the full flow", () => {
		const ledger = copyRelay({ lastLedger: { empty: true } }).lastLedger;
		const decision = nudgeDecision(
			stateWithRelay({ fullFlow: true, lastLedger: ledger }),
			outside,
		);
		expect(decision.kind).toBe("handoff");
	});
});
