// Red contract: the fork wall clock is derived from this session's measured
// requests for this model. The model no longer supplies `time`; the system
// does. A turn is one LLM request. Two measured 20s requests average 20s, and
// four declared turns buy 80s. Lifetime totals are not a sample source.

import { describe, expect, test } from "bun:test";

import { createBracketLedger } from "../src/scope/ledger-brackets.mjs";
import { forkOf } from "../src/scope/ledger-charge.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";
import { validateFork } from "../src/station/domain/fork-join.mjs";
import { createState } from "../src/scope/state.mjs";
import { recordTurnSample } from "../src/scope/turn-stats.mjs";
import { loadDoc } from "../src/prompts/index.mjs";

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
					path: "devops.parser",
					fsm: "read the parser",
					profession: "You are a careful parser reader like Ada Lovelace.",
					budget: { read: 2, bash: 2 },
					targets: ["src/parser.mjs"],
					...argumentsForFork,
				},
			],
		},
	};
}

describe("fork time is derived from measured turns", () => {
	test("two 20s turns and four turns buy an 80s wall clock", () => {
		const ledger = createBracketLedger();
		const spawned = [];
		const station = stationWith(ledger, spawned);
		// Budgets read this session's per-model samples, not lifetime totals.
		station.state.baseModelKey = "test/model";
		recordTurnSample(ledger, "test/model", 20_000);
		recordTurnSample(ledger, "test/model", 20_000);

		const out = handleForkCall(station, forkCall({}));
		expect(out.isError).toBeUndefined();
		expect(spawned).toHaveLength(1);

		const record = forkOf(ledger, "fork-call");
		expect(record).not.toBeNull();
		expect(record.timeBudgetMs).toBe(80_000);
		expect(record.deadlineAt - record.startedAt).toBe(80_000);
		// The child spec carries the same turns in seconds.
		expect(spawned[0].time).toBe(80);
	});

	test("without samples the default turn duration still buys turns", () => {
		const ledger = createBracketLedger();
		const station = stationWith(ledger);
		const out = handleForkCall(station, forkCall({ budget: { read: 1, bash: 1 } }));
		expect(out.isError).toBeUndefined();
		const record = forkOf(ledger, "fork-call");
		// 60s default per turn x 2 turns.
		expect(record.timeBudgetMs).toBe(120_000);
	});

	test("a fork item without time is valid", () => {
		const verdict = validateFork({
			path: "devops.parser",
			fsm: "read the parser",
			profession: "You are a careful parser reader like Ada Lovelace.",
			budget: { read: 2, bash: 2 },
			targets: ["src/parser.mjs"],
		});
		expect(verdict.ok).toBe(true);
		expect(verdict.time).toBeUndefined();
	});

	test("the model-facing copy tells the model not to pass a clock", () => {
		const doc = loadDoc("tools/fork-join");
		// `time` is derived, so the only thing the model may do is leave it out.
		// A copy that stopped saying so would invite a field the validator
		// refuses, and the model would learn the rule only through an error.
		expect(doc["fork.time"]).toBeDefined();
		expect(doc["fork.time"]).toMatch(/Do not pass `time`/i);
		expect(doc["fork.time"]).toMatch(/turns/i);
	});

	test("the model-facing fork copy no longer asks the model to price a clock", () => {
		const doc = loadDoc("tools/fork-join");
		const copy = Object.entries(doc)
			.filter(([name]) => name.startsWith("fork."))
			.map(([, value]) => value)
			.join("\n");
		// No instruction may ask for a duration in seconds: that is the system's
		// derivation, and a model that supplies one is guessing.
		expect(copy).not.toMatch(/time budget|wall[- ]clock budget/i);
	});
});
