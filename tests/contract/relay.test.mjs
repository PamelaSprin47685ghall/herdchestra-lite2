// Contract: every relay implementation answers the same four methods.
//
// The three levels differ in what they owe, not in their shape. These cases run
// against all three through the harness, so a future implementation that drifts
// (returns a different shape, or silently succeeds where it should refuse) goes
// red with its own name in the message.

import { expect } from "bun:test";

import { defineContract, expectRefusal } from "./_harness.mjs";
import { relayImplementations } from "../../src/features/relay/index.mjs";

const OPEN = { empty: false, open: 3, total: 5 };
const EMPTY = { empty: true, open: 0, total: 5 };

defineContract("relay", {
	implementations: relayImplementations,
	cases: {
		"answers the same method set"(impl) {
			for (const method of ["record", "status", "advance"]) {
				expect(typeof impl[method]).toBe("function");
			}
			expect(typeof impl.name).toBe("string");
		},

		"status is always a verdict with a kind"(impl) {
			const status = impl.status(null);
			expect(status.kind).toBe(impl.name);
			expect(typeof status.owes).toBe("boolean");
			expect(typeof status.canStop).toBe("boolean");
		},

		"record never throws and reports whether it stored anything"(impl) {
			const result = impl.record(OPEN);
			expect(typeof result.ok).toBe("boolean");
			if (result.ok) expect(typeof result.recorded).toBe("boolean");
			else expectRefusal(result, result.code);
		},

		"the right to stop follows what the level owes"(impl) {
			const status = impl.status(null);
			// `none` owes nothing, so stopping is lawful; a level that owes a
			// ledger must not stop silently while nothing is recorded.
			expect(status.canStop).toBe(status.owes === false);
		},
	},
});
