import { describe, expect, test } from "bun:test";

import {
	NAMED_SWITCHES,
	PORT_NAMES,
	PORTS,
	disableName,
	switchName,
} from "../src/core/ports/registry.mjs";
import { readSwitch, resolvePorts } from "../src/core/ports/resolve.mjs";

const EMPTY = {};

describe("port registry", () => {
	test("twelve ports, each with a default that is one of its implementations", () => {
		expect(PORT_NAMES).toHaveLength(12);
		for (const port of PORT_NAMES) {
			const entry = PORTS[port];
			expect(entry.implementations.length).toBeGreaterThanOrEqual(2);
			expect(entry.implementations).toContain(entry.fallback);
		}
	});

	test("scope keeps two implementations, relay three", () => {
		// `single` was the retired one-container protocol. The scope port now
		// only names fork/join being available (`batch`) or not (`bare`).
		expect(PORTS.scope.implementations).toEqual(["bare", "batch"]);
		expect(PORTS.relay.implementations).toEqual(["none", "ledger", "handoff"]);
		expect([...NAMED_SWITCHES]).toEqual(["scope", "relay"]);
	});

	test("a switch name derives from the port name in upper snake case", () => {
		expect(switchName("scope")).toBe("HERD_SCOPE");
		expect(switchName("relay")).toBe("HERD_RELAY");
		expect(switchName("modelSwitch")).toBe("HERD_MODEL_SWITCH");
		expect(switchName("clock")).toBe("HERD_CLOCK");
	});

	test("a disable name keeps the port's word boundary", () => {
		expect(disableName("clock")).toBe("HERD_DISABLE_CLOCK");
		expect(disableName("chineseReminder")).toBe("HERD_DISABLE_CHINESE_REMINDER");
		expect(disableName("modelSwitch")).toBe("HERD_DISABLE_MODEL_SWITCH");
		expect(readSwitch("modelSwitch", { HERD_DISABLE_MODEL_SWITCH: "1" })).toEqual({
			ok: true,
			implementation: "off",
			explicit: true,
		});
	});
});

describe("environment resolution", () => {
	test("nothing set means the port's fallback, not marked explicit", () => {
		expect(readSwitch("scope", EMPTY)).toEqual({ ok: true, implementation: "batch", explicit: false });
		expect(readSwitch("relay", EMPTY)).toEqual({ ok: true, implementation: "handoff", explicit: false });
		expect(readSwitch("clock", EMPTY)).toEqual({ ok: true, implementation: "on", explicit: false });
	});

	test("scope and relay read an implementation name", () => {
		expect(readSwitch("scope", { HERD_SCOPE: "bare" })).toEqual({
			ok: true,
			implementation: "bare",
			explicit: true,
		});
		expect(readSwitch("relay", { HERD_RELAY: "ledger" })).toEqual({
			ok: true,
			implementation: "ledger",
			explicit: true,
		});
	});

	test("an unknown implementation is refused with what is available", () => {
		expect(readSwitch("scope", { HERD_SCOPE: "fission" })).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "scope",
			wanted: "fission",
			available: ["bare", "batch"],
		});
	});

	test("the boolean form equals choosing off", () => {
		expect(readSwitch("clock", { HERD_DISABLE_CLOCK: "1" })).toEqual({
			ok: true,
			implementation: "off",
			explicit: true,
		});
		expect(readSwitch("clock", { HERD_DISABLE_CLOCK: "0" })).toEqual({
			ok: true,
			implementation: "on",
			explicit: false,
		});
	});

	test("an unknown port has no switch", () => {
		expect(readSwitch("nope", EMPTY)).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "nope",
			wanted: null,
			available: [],
		});
	});
});

describe("ticket uses", () => {
	test("nothing asked means the environment wins everywhere", () => {
		const resolved = resolvePorts({}, { HERD_SCOPE: "bare" });
		expect(resolved.ok).toBe(true);
		expect(resolved.ports.scope).toBe("bare");
		expect(resolved.ports.relay).toBe("handoff");
	});

	test("a retired implementation is refused with the available list", () => {
		// `single` was the one-container begin/end protocol. Asking for it now
		// is a configuration error, not a silent fallback to `batch`.
		expect(resolvePorts({}, { HERD_SCOPE: "single" })).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "scope",
			wanted: "single",
			available: ["bare", "batch"],
		});
	});

	test("a ticket may pick another implementation when the environment said nothing", () => {
		const resolved = resolvePorts({ scope: "bare" }, EMPTY);
		expect(resolved.ok).toBe(true);
		expect(resolved.ports.scope).toBe("bare");
	});

	test("an explicit environment choice beats the ticket", () => {
		expect(resolvePorts({ scope: "batch" }, { HERD_SCOPE: "bare" })).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "scope",
			wanted: "batch",
			available: ["bare"],
		});
	});

	test("a disabled port cannot be reopened by a ticket", () => {
		expect(resolvePorts({ clock: "on" }, { HERD_DISABLE_CLOCK: "1" })).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "clock",
			wanted: "on",
			available: ["off"],
		});
	});

	test("an unknown port in uses is refused", () => {
		expect(resolvePorts({ telemetry: "on" }, EMPTY)).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "telemetry",
			wanted: "on",
			available: [],
		});
	});

	test("uses must be a plain object", () => {
		expect(resolvePorts([], EMPTY)).toEqual({
			ok: false,
			code: "INVALID_USES",
			detail: "uses must be a plain object",
		});
	});
});
