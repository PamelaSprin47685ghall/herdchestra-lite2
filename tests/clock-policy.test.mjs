// The clock policy, independent of the port object.
//
// `src/scope/clock.mjs` owns the arithmetic the old fork module kept inline.
// These cases pin the facts a reload depends on: a pause freezes the remaining
// time, a resume shifts the deadline by exactly the paused span, and the
// deadline itself reads as overtime. The record is the only state.

import { expect, test } from "bun:test";

import { deadlineInfo, pauseClock, resumeClock } from "../src/scope/clock.mjs";

function record(overrides = {}) {
	return {
		timeBudgetMs: 60_000,
		startedAt: 1_000,
		deadlineAt: 61_000,
		clockPausedAt: null,
		pausedMs: 0,
		overtimeAt: null,
		...overrides,
	};
}

test("deadlineInfo counts down and treats the deadline as overtime", () => {
	expect(deadlineInfo(record(), 31_000)).toEqual({
		bounded: true,
		overtime: false,
		leftMs: 30_000,
	});
	expect(deadlineInfo(record(), 61_000)).toEqual({
		bounded: true,
		overtime: true,
		leftMs: 0,
	});
	expect(deadlineInfo(record({ deadlineAt: null }), 31_000)).toEqual({
		bounded: false,
	});
});

test("a pause freezes the remaining time", () => {
	const fork = record();
	expect(pauseClock(fork, 31_000)).toBe(true);
	expect(fork.clockPausedAt).toBe(31_000);
	expect(deadlineInfo(fork, 41_000)).toEqual({
		bounded: true,
		overtime: false,
		leftMs: 30_000,
	});
});

test("a resume shifts the deadline by exactly the paused span", () => {
	const fork = record();
	pauseClock(fork, 31_000);
	expect(resumeClock(fork, 41_000)).toBe(true);
	expect(fork.deadlineAt).toBe(71_000);
	expect(fork.pausedMs).toBe(10_000);
	expect(fork.clockPausedAt).toBeNull();
	expect(deadlineInfo(fork, 51_000)).toEqual({
		bounded: true,
		overtime: false,
		leftMs: 20_000,
	});
});

test("repeated pauses and a resume without a pause change nothing", () => {
	const fork = record();
	expect(pauseClock(fork, 31_000)).toBe(true);
	expect(pauseClock(fork, 35_000)).toBe(false);
	expect(fork.clockPausedAt).toBe(31_000);

	expect(resumeClock(fork, 41_000)).toBe(true);
	expect(resumeClock(fork, 45_000)).toBe(false);
	expect(fork.deadlineAt).toBe(71_000);
	expect(fork.pausedMs).toBe(10_000);
});
