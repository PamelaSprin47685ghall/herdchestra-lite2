// Two ports that must be closable one at a time: closing status must leave the
// observer recording, and closing the observer must leave the footer intact.

import { describe, expect, test } from "bun:test";

import { defineContract } from "./_harness.mjs";
import { createObserverOff, createObserverOn } from "../../src/features/observer/index.mjs";
import { createStatusOff, createStatusOn } from "../../src/features/status/index.mjs";

const SNAPSHOT = { cost: "$0.04", tokens: "12k", model: "test-model" };
const FRAME = { revision: "r1", count: 3 };

defineContract("status", {
	implementations: { on: createStatusOn(), off: createStatusOff() },
	cases: {
		"renders a string for any snapshot"(_impl, ctx) {
			expect(typeof _impl.render(SNAPSHOT)).toBe("string");
		},
		"tolerates a missing snapshot"(_impl) {
			expect(typeof _impl.render(undefined)).toBe("string");
		},
		"keeps no state when off"(_impl) {
			const first = _impl.render(SNAPSHOT);
			const second = _impl.render({ cost: "$9.99" });
			if (_impl.name === "off") {
				expect(first).toBe("");
				expect(second).toBe("");
			} else {
				expect(second).toContain("$9.99");
			}
		},
	},
});

defineContract("observer", {
	implementations: { on: createObserverOn(), off: createObserverOff() },
	cases: {
		"observe returns a result"(_impl) {
			expect(_impl.observe(FRAME)).toEqual({ ok: true });
		},
		"report has the same shape for every implementation"(_impl) {
			_impl.observe(FRAME);
			const report = _impl.report();
			expect(typeof report.seen).toBe("number");
			expect(Object.hasOwn(report, "last")).toBe(true);
		},
		"off forgets what it saw"(_impl) {
			// Cases share one implementation instance, so this asserts the
			// direction, not an absolute count: `on` accumulates, `off` stays 0.
			_impl.observe(FRAME);
			_impl.observe(FRAME);
			const report = _impl.report();
			if (_impl.name === "off") {
				expect(report.seen).toBe(0);
				expect(report.last).toBeNull();
			} else {
				expect(report.seen).toBeGreaterThan(0);
				expect(report.last).toEqual({ revision: "r1", count: 3 });
			}
		},
	},
});

describe("the two ports are independent", () => {
	test("closing status leaves the observer recording", () => {
		const status = createStatusOff();
		const observer = createObserverOn();
		observer.observe(FRAME);
		expect(status.render(SNAPSHOT)).toBe("");
		expect(observer.report().seen).toBe(1);
	});

	test("closing the observer leaves the footer intact", () => {
		const status = createStatusOn();
		const observer = createObserverOff();
		observer.observe(FRAME);
		expect(observer.report().seen).toBe(0);
		expect(status.render(SNAPSHOT)).toContain("$0.04");
	});
});
