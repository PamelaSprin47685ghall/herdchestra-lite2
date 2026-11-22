// The clock contract, run against the record policy.
//
// The port is stateless: `start` fills the persisted fork record, and every
// other call reads or mutates that record. The keyed-map shape is gone.

import { describe, expect, test } from "bun:test";

import {
	CLOCK_IMPLEMENTATIONS,
	createClockOff,
	createClockOn,
} from "../../src/scope/clock.mjs";

function record(overrides = {}) {
	return {
		timeBudgetMs: 5_000,
		startedAt: 1_000,
		deadlineAt: null,
		clockPausedAt: null,
		pausedMs: 0,
		overtimeAt: null,
		...overrides,
	};
}

describe("clock: on", () => {
	test("starts the deadline on the record and counts down", () => {
		const clock = createClockOn();
		const fork = record();
		expect(clock.start(fork, fork.timeBudgetMs, fork.startedAt)).toEqual({
			ok: true,
			deadlineAt: 6_000,
		});
		expect(clock.info(fork, 3_000)).toEqual({
			bounded: true,
			overtime: false,
			leftMs: 3_000,
		});
		expect(clock.toolLimit(fork, 3_000)).toBe(4_000);
	});

	test("a pause freezes and a resume shifts the deadline", () => {
		const clock = createClockOn();
		const fork = record();
		clock.start(fork, fork.timeBudgetMs, fork.startedAt);
		expect(clock.pause(fork, 3_000)).toBe(true);
		expect(clock.info(fork, 4_000)).toEqual({
			bounded: true,
			overtime: false,
			leftMs: 3_000,
		});
		expect(clock.resume(fork, 5_000)).toBe(true);
		expect(fork.deadlineAt).toBe(8_000);
		expect(fork.pausedMs).toBe(2_000);
		expect(fork.clockPausedAt).toBeNull();
	});

	test("the deadline is overtime and the tool limit is one second", () => {
		const clock = createClockOn();
		const fork = record();
		clock.start(fork, fork.timeBudgetMs, fork.startedAt);
		expect(clock.info(fork, 7_000)).toEqual({
			bounded: true,
			overtime: true,
			leftMs: 0,
		});
		expect(clock.toolLimit(fork, 7_000)).toBe(1_000);
		expect(fork.overtimeAt).toBe(7_000);
	});
});

describe("clock: off", () => {
	test("start clears the record and nothing is gated", () => {
		const clock = createClockOff();
		const fork = record({ deadlineAt: 6_000, clockPausedAt: 3_000 });
		expect(clock.start(fork, fork.timeBudgetMs, fork.startedAt)).toEqual({ ok: true });
		expect(fork.deadlineAt).toBeNull();
		expect(fork.clockPausedAt).toBeNull();
		expect(clock.info(fork, 3_000)).toEqual({ bounded: false });
		expect(clock.toolLimit(fork, 3_000)).toBeNull();
		expect(clock.pause(fork, 3_000)).toBe(false);
		expect(clock.resume(fork, 4_000)).toBe(false);
	});
});

describe("the two implementations share one shape", () => {
	test("names and bounded flags", () => {
		expect(CLOCK_IMPLEMENTATIONS.on().name).toBe("on");
		expect(CLOCK_IMPLEMENTATIONS.off().name).toBe("off");
		expect(CLOCK_IMPLEMENTATIONS.on().bounded).toBe(true);
		expect(CLOCK_IMPLEMENTATIONS.off().bounded).toBe(false);
	});
});
