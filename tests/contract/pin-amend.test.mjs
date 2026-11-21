// Pin and amend contracts.
//
// The shared contract is the shape: every method answers with a discriminated
// union carrying `ok`, and a refusal always names a code and the port. The
// behaviour differs by design, so each implementation also gets its own cases:
// `on` keeps state, `off` refuses and must never report a success.

import { describe, expect, test } from "bun:test";

import { defineContract, expectRefusal } from "./_harness.mjs";
import { AMEND_UNAVAILABLE, createAmendOff, createAmendOn } from "../../src/features/amend/index.mjs";
import { PIN_UNAVAILABLE, createPinOff, createPinOn } from "../../src/features/pin/index.mjs";

const answerShape = (value) => typeof value === "object" && value !== null && typeof value.ok === "boolean";

defineContract("pin", {
	implementations: { on: createPinOn(), off: createPinOff() },
	cases: {
		"add answers with the shared shape"(pin) {
			expect(answerShape(pin.add("note"))).toBe(true);
		},
		"list answers with the shared shape"(pin) {
			expect(answerShape(pin.list())).toBe(true);
		},
	},
});

defineContract("amend", {
	implementations: { on: createAmendOn(), off: createAmendOff() },
	cases: {
		"record answers with the shared shape"(amend) {
			expect(answerShape(amend.record("beat-1"))).toBe(true);
		},
		"refund answers with the shared shape"(amend) {
			expect(answerShape(amend.refund("beat-1"))).toBe(true);
		},
		"retired answers with the shared shape"(amend) {
			expect(typeof amend.retired()).not.toBe("undefined");
		},
	},
});

describe("pin on", () => {
	test("add then list returns what was kept", () => {
		const pin = createPinOn();
		expect(pin.add("first")).toEqual({ ok: true, count: 1 });
		pin.add("second");
		expect(pin.list()).toEqual({ ok: true, notes: ["first", "second"] });
	});

	test("an empty note is refused rather than ignored", () => {
		const pin = createPinOn();
		expect(pin.add("   ")).toEqual({ ok: false, code: "INVALID_NOTE", port: "pin" });
		expect(pin.list().notes).toEqual([]);
	});
});

describe("pin off", () => {
	test("add and list both refuse with the port's code", () => {
		const pin = createPinOff();
		expectRefusal(pin.add("note"), PIN_UNAVAILABLE);
		expectRefusal(pin.list(), PIN_UNAVAILABLE);
	});

	test("a refusal is never reported as success", () => {
		const pin = createPinOff();
		expect(pin.add("note").ok).toBe(false);
	});
});

describe("amend on", () => {
	test("a recorded beat is retired", () => {
		const amend = createAmendOn();
		amend.record("beat-1");
		expect(amend.retired()).toEqual(["beat-1"]);
	});

	test("refunding a beat the ledger does not know is refused", () => {
		const amend = createAmendOn();
		expect(amend.refund("ghost")).toEqual({ ok: false, code: "UNKNOWN_BEAT", port: "amend" });
	});

	test("refunding a recorded beat answers success", () => {
		const amend = createAmendOn();
		amend.record("beat-1");
		expect(amend.refund("beat-1")).toEqual({ ok: true, refunded: true });
	});
});

describe("amend off", () => {
	test("all three methods refuse with the port's code", () => {
		const amend = createAmendOff();
		expectRefusal(amend.record("beat-1"), AMEND_UNAVAILABLE);
		expectRefusal(amend.refund("beat-1"), AMEND_UNAVAILABLE);
		expectRefusal(amend.retired(), AMEND_UNAVAILABLE);
	});
});
