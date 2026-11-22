// Red contract: the fork wall clock is derived from the session's two
// sufficient statistics. The model no longer supplies `time`; the system does.
// A turn is one LLM request. With {turnMs: 40000, turns: 2} the average is 20s,
// and four declared tool points buy 80s.

import { describe, expect, test } from "bun:test";

import { createBracketLedger, forkOf } from "../src/scope/forkjoin.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";
import { validateFork } from "../src/station/domain/fork-join.mjs";
import { createState } from "../src/scope/state.mjs";
import * as descriptions from "../src/tools/descriptions.mjs";

function stationWith(ledger, spawned = []) {
	return {
		state: createState(),
		forkLedgerPort: () => ledger,
		childSpawnPort: () => (spec) => spawned.push(spec),
	};
}

function forkCall(argumentsForFork) {
	return {
		id: "fork-call",
		arguments: {
			forks: [
				{
					scopeId: "parser",
					intent: "read the parser",
					blocked: false,
					budget: { read: 2, bash: 2 },
					targets: ["src/parser.mjs"],
					...argumentsForFork,
				},
			],
		},
	};
}

describe("fork time is derived from measured turns", () => {
	test("two 20s turns and four points buy an 80s wall clock", () => {
		const ledger = createBracketLedger();
		ledger.totals = { turnMs: 40_000, turns: 2 };
		const spawned = [];
		const station = stationWith(ledger, spawned);

		const out = handleForkCall(station, forkCall({}));
		expect(out.isError).toBeUndefined();
		expect(spawned).toHaveLength(1);

		const record = forkOf(ledger, "fork-call");
		expect(record).not.toBeNull();
		expect(record.timeBudgetMs).toBe(80_000);
		expect(record.deadlineAt - record.startedAt).toBe(80_000);
		// The child spec carries the same budget in seconds.
		expect(spawned[0].time).toBe(80);
	});

	test("without samples the default turn duration still buys points", () => {
		const ledger = createBracketLedger();
		const station = stationWith(ledger);
		const out = handleForkCall(station, forkCall({ budget: { read: 1, bash: 1 } }));
		expect(out.isError).toBeUndefined();
		const record = forkOf(ledger, "fork-call");
		// 60s default per turn x 2 points.
		expect(record.timeBudgetMs).toBe(120_000);
	});

	test("a fork item without time is valid", () => {
		const verdict = validateFork({
			scopeId: "parser",
			intent: "read the parser",
			blocked: false,
			budget: { read: 2, bash: 2 },
			targets: ["src/parser.mjs"],
		});
		expect(verdict.ok).toBe(true);
		expect(verdict.time).toBeUndefined();
	});

	test("the fork schema no longer offers a time field", () => {
		const item = descriptions.forkParameters.properties.forks.items;
		expect(item.properties.time).toBeUndefined();
		expect(item.required).not.toContain("time");
		// The tool stays strict: a stale caller that still sends time is rejected.
		expect(item.additionalProperties).toBe(false);
	});

	test("the model-facing fork copy does not ask for a wall clock", () => {
		const copy = Object.entries(descriptions)
			.filter(([name, value]) => name.startsWith("FORK_") && typeof value === "string")
			.map(([, value]) => value)
			.join("\n");
		expect(copy).not.toMatch(/\bseconds?\b|wall[- ]clock|time budget/i);
	});
});
