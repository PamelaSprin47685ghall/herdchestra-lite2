// A fork batch has no fanout ceiling and a scope has no point ceiling.
//
// The consumer is the model that splits work: the runtime charges it nothing
// for a large batch and warns it about nothing. Seven items land whole, the
// blocked entry included, and the batch validator returns no warnings at all.

import { describe, expect, test } from "bun:test";

import { createBracketLedger } from "../src/scope/index.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";
import { validateForkBatch } from "../src/station/domain/fork-join.mjs";

const NOW = 1_700_000_000_000;

function warnings(text) {
	return (text.match(/WARNING/g) ?? []).length;
}

function forkStation(ledger) {
	const spawned = [];
	return {
		state: {
			scopes: [],
			autopilot: false,
			relay: { generation: 0, fullFlow: false },
		},
		forkLedgerPort: () => ledger,
		childSpawnPort: () => (spec) => {
			spawned.push(spec);
		},
		persist: () => true,
		now: () => NOW,
		spawned,
	};
}

function forkItem(scopeId, overrides = {}) {
	return {
		scopeId,
		profession: `You are a scoped worker for ${scopeId}.`,
		fsm: `work on ${scopeId}`,
		blocked: false,
		budget: { read: 6 },
		targets: [`src/${scopeId}.mjs`],
		...overrides,
	};
}

describe("one fork call holds as many children as the work has", () => {
	test("seven items, one of them blocked, start without a warning", () => {
		const ledger = createBracketLedger();
		const station = forkStation(ledger);
		const forks = Array.from({ length: 6 }, (_, i) => forkItem(`s${i}`));
		forks.push(forkItem("s6", { blocked: true, budget: { read: 1 } }));
		const result = handleForkCall(station, {
			id: "call-7",
			arguments: { forks },
		});
		expect(result.isError).toBeUndefined();
		expect(warnings(result.content[0].text)).toBe(0);
		expect(ledger.order).toHaveLength(7);
		expect(station.spawned).toHaveLength(6);
	});

	test("the batch validator judges identity, not size", () => {
		const forks = Array.from({ length: 12 }, (_, i) => forkItem(`s${i}`));
		const out = validateForkBatch({ forks });
		expect(out.ok).toBe(true);
		expect(out.warnings).toEqual([]);
		expect(out.items).toHaveLength(12);
	});

	test("a fork item priced far past the retired cap is accepted whole", () => {
		const out = validateForkBatch({
			forks: [forkItem("big", { budget: { read: 120 } })],
		});
		expect(out.ok).toBe(true);
		expect(out.warnings).toEqual([]);
		expect(out.items).toHaveLength(1);
	});
});
