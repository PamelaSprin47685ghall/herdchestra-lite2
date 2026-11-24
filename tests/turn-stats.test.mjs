// Red contract: lifetime totals survive a reload, but time estimates use
// only this session's samples for the model in use. Samples are in memory,
// keyed by ledger identity, so a restored ledger starts empty and one model's
// speed never sets another model's time estimate.

import { describe, expect, test } from "bun:test";

import {
	DEFAULT_TURN_MS,
	MAX_SAMPLE_MS,
	SAMPLE_LIMIT,
	abandonRequest,
	averageTurnMs,
	beginRequest,
	deriveTimeBudgetSeconds,
	emptyTotals,
	finishRequest,
	modelSamples,
	normalizeTotals,
	recordTurnSample,
	recentAverageTurnMs,
	sumTurns,
} from "../src/scope/turn-stats.mjs";

function ledger() {
	return {};
}

describe("turn totals", () => {
	test("a fresh totals value is empty", () => {
		expect(emptyTotals()).toEqual({ turnMs: 0, turns: 0 });
	});

	test("one request accumulates its wall time and one turn", () => {
		const clock = { startedAt: null };
		const totals = emptyTotals();
		beginRequest(clock, 1_000);
		expect(clock.startedAt).toBe(1_000);
		expect(finishRequest(clock, totals, 1_750)).toBe(750);
		expect(totals).toEqual({ turnMs: 750, turns: 1 });
		expect(clock.startedAt).toBeNull();
	});

	test("two concurrent scopes write their durations into the same totals", () => {
		const first = { startedAt: null };
		const second = { startedAt: null };
		const totals = emptyTotals();
		beginRequest(first, 0);
		beginRequest(second, 0);
		finishRequest(first, totals, 3_000);
		finishRequest(second, totals, 5_000);
		expect(totals).toEqual({ turnMs: 8_000, turns: 2 });
	});

	test("begin does not reset an in-flight request", () => {
		const clock = { startedAt: null };
		const totals = emptyTotals();
		beginRequest(clock, 100);
		beginRequest(clock, 900);
		expect(clock.startedAt).toBe(100);
		finishRequest(clock, totals, 400);
		expect(totals).toEqual({ turnMs: 300, turns: 1 });
	});

	test("finishing without a start changes nothing and returns null", () => {
		const clock = { startedAt: null };
		const totals = { turnMs: 10, turns: 2 };
		expect(finishRequest(clock, totals, 500)).toBeNull();
		expect(totals).toEqual({ turnMs: 10, turns: 2 });
	});

	test("a backwards clock changes nothing", () => {
		const clock = { startedAt: 500 };
		const totals = { turnMs: 10, turns: 2 };
		expect(finishRequest(clock, totals, 499)).toBeNull();
		expect(clock.startedAt).toBe(500);
		expect(totals).toEqual({ turnMs: 10, turns: 2 });
	});

	test("abandon drops the request without counting a turn", () => {
		const clock = { startedAt: 500 };
		const totals = { turnMs: 10, turns: 2 };
		abandonRequest(clock);
		expect(clock.startedAt).toBeNull();
		expect(totals).toEqual({ turnMs: 10, turns: 2 });
	});

	test("lifetime totals never carry samples", () => {
		const clock = { startedAt: null };
		const totals = emptyTotals();
		beginRequest(clock, 1_000);
		finishRequest(clock, totals, 1_400);
		expect(totals).toEqual({ turnMs: 400, turns: 1 });
		expect(normalizeTotals({ turnMs: 5, turns: 2, samples: [1_500] })).toEqual({
			turnMs: 5,
			turns: 2,
		});
	});

	test("average is null before the first turn", () => {
		expect(averageTurnMs(emptyTotals())).toBeNull();
		expect(averageTurnMs({ turnMs: 0, turns: 0 })).toBeNull();
		expect(averageTurnMs({ turnMs: 40_000, turns: 2 })).toBe(20_000);
	});
});

describe("session and model sample isolation", () => {
	test("one model's samples never set another model's budget", () => {
		const session = ledger();
		for (let i = 0; i < 3; i += 1) recordTurnSample(session, "a", 2_000);
		recordTurnSample(session, "b", 9_000);
		expect(modelSamples(session, "a")).toEqual([2_000, 2_000, 2_000]);
		expect(
			deriveTimeBudgetSeconds({ samples: modelSamples(session, "a"), budget: { read: 1 } }),
		).toBe(2);
		expect(
			deriveTimeBudgetSeconds({ samples: modelSamples(session, "b"), budget: { read: 1 } }),
		).toBe(9);
	});

	test("a model with no sample falls back to one minute per point", () => {
		const session = ledger();
		recordTurnSample(session, "a", 2_000);
		expect(
			deriveTimeBudgetSeconds({ samples: modelSamples(session, "other"), budget: { read: 2 } }),
		).toBe(120);
	});

	test("a restored ledger has no samples from the previous run", () => {
		const before = ledger();
		recordTurnSample(before, "m", 5_000);
		const afterRestore = ledger();
		expect(modelSamples(afterRestore, "m")).toEqual([]);
		expect(
			deriveTimeBudgetSeconds({ samples: modelSamples(afterRestore, "m"), budget: { read: 1 } }),
		).toBe(DEFAULT_TURN_MS / 1000);
	});

	test("scopes sharing one ledger merge their samples", () => {
		const shared = ledger();
		recordTurnSample(shared, "m", 2_000);
		recordTurnSample(shared, "m", 6_000);
		expect(modelSamples(shared, "m")).toEqual([2_000, 6_000]);
		expect(recentAverageTurnMs(modelSamples(shared, "m"))).toBe(4_000);
		expect(
			deriveTimeBudgetSeconds({ samples: modelSamples(shared, "m"), budget: { read: 1 } }),
		).toBe(4);
	});

	test("samples without a model identity are not recorded", () => {
		const session = ledger();
		expect(recordTurnSample(session, "", 9_000)).toBe(false);
		expect(modelSamples(session, "")).toEqual([]);
	});
});

describe("rolling window and bounds", () => {
	test("one slow request is clamped instead of inflating every budget", () => {
		const session = ledger();
		recordTurnSample(session, "m", 600_000);
		expect(modelSamples(session, "m")).toEqual([MAX_SAMPLE_MS]);
		expect(
			deriveTimeBudgetSeconds({ samples: modelSamples(session, "m"), budget: { read: 1 } }),
		).toBe(120);
	});

	test("a sub-second request is not a sample", () => {
		const session = ledger();
		expect(recordTurnSample(session, "m", 400)).toBe(false);
		expect(modelSamples(session, "m")).toEqual([]);
	});

	test("the window keeps only the most recent entries", () => {
		const session = ledger();
		for (let i = 0; i < SAMPLE_LIMIT; i += 1) recordTurnSample(session, "m", 2_000);
		for (let i = 0; i < SAMPLE_LIMIT; i += 1) recordTurnSample(session, "m", 10_000);
		expect(modelSamples(session, "m")).toHaveLength(SAMPLE_LIMIT);
		expect(recentAverageTurnMs(modelSamples(session, "m"))).toBe(10_000);
	});
});

describe("derived fork time limit", () => {
	test("turns are the sum of finite positive tool counts", () => {
		expect(sumTurns({ read: 2, bash: 3 })).toBe(5);
		expect(sumTurns({ read: 2, bad: -1, nan: Number.NaN, text: "3" })).toBe(2);
		expect(sumTurns(null)).toBe(0);
		expect(sumTurns({})).toBe(0);
	});

	test("time is the sample mean times the declared points", () => {
		expect(
			deriveTimeBudgetSeconds({
				samples: [20_000, 20_000],
				budget: { read: 2, bash: 2 },
			}),
		).toBe(80);
	});

	test("no sample falls back to the default turn duration", () => {
		expect(DEFAULT_TURN_MS).toBe(60_000);
		expect(deriveTimeBudgetSeconds({ samples: [], budget: { read: 1, bash: 1 } })).toBe(120);
	});

	test("a custom fallback is honored", () => {
		expect(
			deriveTimeBudgetSeconds({
				samples: [],
				budget: { read: 0.5 },
				fallbackMs: 10_000,
			}),
		).toBe(5);
	});

	test("the result is rounded and never below one second", () => {
		expect(deriveTimeBudgetSeconds({ samples: [1_500], budget: { read: 1 } })).toBe(2);
		expect(deriveTimeBudgetSeconds({ samples: [], budget: { read: 0.001 } })).toBe(1);
		expect(deriveTimeBudgetSeconds({ samples: [], budget: {} })).toBe(1);
	});
});
