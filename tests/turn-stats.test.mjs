// Red contract: the session keeps only two sufficient statistics for turn
// timing. One turn is one LLM request. Concurrent scopes add their own request
// durations into the same totals, so k concurrent scopes grow turnMs k times.

import { describe, expect, test } from "bun:test";

import {
	DEFAULT_TURN_MS,
	abandonRequest,
	averageTurnMs,
	beginRequest,
	deriveTimeBudgetSeconds,
	emptyTotals,
	finishRequest,
	normalizeTotals,
	sumBudgetPoints,
} from "../src/scope/turn-stats.mjs";

describe("turn statistics", () => {
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

	test("average is null before the first turn", () => {
		expect(averageTurnMs(emptyTotals())).toBeNull();
		expect(averageTurnMs({ turnMs: 0, turns: 0 })).toBeNull();
		expect(averageTurnMs({ turnMs: 40_000, turns: 2 })).toBe(20_000);
	});

	test("legacy totals without the fields normalize to zero", () => {
		expect(normalizeTotals(undefined)).toEqual({ turnMs: 0, turns: 0 });
		expect(normalizeTotals({})).toEqual({ turnMs: 0, turns: 0 });
		expect(normalizeTotals({ turnMs: -5, turns: Number.NaN })).toEqual({ turnMs: 0, turns: 0 });
		expect(normalizeTotals({ turnMs: 5.5, turns: 2 })).toEqual({ turnMs: 5.5, turns: 2 });
	});
});

describe("derived fork time budget", () => {
	test("points are the sum of finite positive tool budgets", () => {
		expect(sumBudgetPoints({ read: 2, bash: 3 })).toBe(5);
		expect(sumBudgetPoints({ read: 2, bad: -1, nan: Number.NaN, text: "3" })).toBe(2);
		expect(sumBudgetPoints(null)).toBe(0);
		expect(sumBudgetPoints({})).toBe(0);
	});

	test("time is average turn duration times the declared points", () => {
		// 40s over 2 requests = 20s per turn; 4 points = 80s.
		expect(
			deriveTimeBudgetSeconds({
				totals: { turnMs: 40_000, turns: 2 },
				budget: { read: 2, bash: 2 },
			}),
		).toBe(80);
	});

	test("no sample falls back to the default turn duration", () => {
		expect(DEFAULT_TURN_MS).toBe(60_000);
		expect(
			deriveTimeBudgetSeconds({ totals: emptyTotals(), budget: { read: 1, bash: 1 } }),
		).toBe(120);
	});

	test("a custom fallback is honored", () => {
		expect(
			deriveTimeBudgetSeconds({
				totals: emptyTotals(),
				budget: { read: 0.5 },
				fallbackMs: 10_000,
			}),
		).toBe(5);
	});

	test("the result is rounded and never below one second", () => {
		expect(
			deriveTimeBudgetSeconds({
				totals: { turnMs: 1_500, turns: 1 },
				budget: { read: 1 },
			}),
		).toBe(2);
		expect(
			deriveTimeBudgetSeconds({ totals: { turnMs: 10, turns: 1 }, budget: { read: 1 } }),
		).toBe(1);
		expect(deriveTimeBudgetSeconds({ totals: emptyTotals(), budget: {} })).toBe(1);
	});
});
