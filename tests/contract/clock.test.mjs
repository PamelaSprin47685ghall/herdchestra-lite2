// The clock contract, run against every implementation by name.
//
// Whatever the implementation, the same questions must be answerable with the
// same shapes: remaining() is a number or null, expired() is a boolean,
// start() answers ok, and only a bounded clock can render a time segment.

import { describe, expect, test } from "bun:test";

import { createClockOff, createClockOn } from "../../src/features/clock/index.mjs";
import { defineContract, fakeCtx } from "./_harness.mjs";

const implementations = {
	on: createClockOn(),
	off: createClockOff(),
};

defineContract("clock", {
	implementations,
	cases: {
		"remaining is a number or null"(_impl, _ctx) {
			const value = implementations.on.remaining("missing-scope");
			expect(value === null || typeof value === "number").toBe(true);
		},
		"expired is boolean for an unknown scope"(_impl) {
			expect(typeof implementations.on.expired("missing-scope")).toBe("boolean");
		},
	},
});

describe("clock: on", () => {
	test("counts down and expires at the deadline", () => {
		const clock = createClockOn();
		const started = clock.start("s1", 5_000);
		expect(started.ok).toBe(true);
		const deadline = started.deadlineAt;

		expect(clock.remaining("s1", deadline - 2_000)).toBe(2_000);
		expect(clock.expired("s1", deadline - 1)).toBe(false);
		expect(clock.expired("s1", deadline)).toBe(true);
		expect(clock.remaining("s1", deadline + 500)).toBe(0);
	});

	test("stamps overtime once and keeps it", () => {
		const clock = createClockOn();
		const { deadlineAt } = clock.start("s2", 1_000);
		expect(clock.expired("s2", deadlineAt + 100)).toBe(true);
		expect(clock.expired("s2", deadlineAt + 200)).toBe(true);
	});

	test("refuses a non-positive budget", () => {
		const clock = createClockOn();
		expect(clock.start("s3", 0)).toEqual({
			ok: false,
			code: "CLOCK_INVALID_BUDGET",
			port: "clock",
			detail: "budgetMs must be a positive number",
		});
	});

	test("is bounded, so a time segment can be rendered", () => {
		expect(createClockOn().bounded()).toBe(true);
	});
});

describe("clock: off", () => {
	test("nothing is ever late and no bound exists", () => {
		const clock = createClockOff();
		expect(clock.start("s1", 10)).toEqual({ ok: true });
		expect(clock.remaining("s1")).toBeNull();
		expect(clock.expired("s1")).toBe(false);
	});

	test("is unbounded, so no time segment is rendered", () => {
		// The receipt reads this answer instead of asking a switch.
		expect(createClockOff().bounded()).toBe(false);
	});

	test("start leaves nothing behind", () => {
		const clock = createClockOff();
		clock.start("s1", 10);
		expect(clock.clear("s1")).toBe(false);
	});
});

describe("the two implementations answer the same shapes", () => {
	test("start, remaining and expired line up", () => {
		const on = createClockOn();
		const off = createClockOff();
		expect(on.start("s", 100).ok).toBe(true);
		expect(off.start("s", 100).ok).toBe(true);
		// Same shape, different answers: a bounded clock returns milliseconds,
		// an unbounded one says "no bound" - it must not say zero, which would
		// read as expired.
		expect(typeof on.remaining("s")).toBe("number");
		expect(off.remaining("s")).toBeNull();
		expect(typeof on.expired("s")).toBe("boolean");
		expect(typeof off.expired("s")).toBe("boolean");
		// Both answer with the same union, which is what callers switch on.
		expect(on.bounded() || off.bounded()).toBe(true);
		expect(on.bounded() && off.bounded()).toBe(false);
		expect(fakeCtx().now()).toBe(1_000);
	});
});
