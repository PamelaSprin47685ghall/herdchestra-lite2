import { describe, expect, test } from "bun:test";

import {
	PORT_NAMES,
	PORTS,
	disableName,
	switchName,
} from "../src/core/ports/registry.mjs";
import { readSwitch, resolvePorts } from "../src/core/ports/resolve.mjs";

const EMPTY = {};

describe("port registry", () => {
	test("six ports, each with a default that is one of its implementations", () => {
		expect(PORT_NAMES).toHaveLength(6);
		for (const port of PORT_NAMES) {
			const entry = PORTS[port];
			expect(entry.implementations.length).toBeGreaterThanOrEqual(2);
			expect(entry.implementations).toContain(entry.fallback);
		}
	});

	test("a switch name derives from the port name in upper snake case", () => {
		expect(switchName("modelSwitch")).toBe("HERD_MODEL_SWITCH");
		expect(switchName("clock")).toBe("HERD_CLOCK");
	});

	test("a disable name keeps the port's word boundary", () => {
		expect(disableName("clock")).toBe("HERD_DISABLE_CLOCK");
		expect(disableName("vibeCompat")).toBe("HERD_DISABLE_VIBE_COMPAT");
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
		expect(readSwitch("clock", EMPTY)).toEqual({ ok: true, implementation: "on", explicit: false });
		expect(readSwitch("herd", EMPTY)).toEqual({ ok: true, implementation: "on", explicit: false });
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

	test("a two-implementation port reads its name form", () => {
		expect(readSwitch("clock", { HERD_CLOCK: "off" })).toEqual({
			ok: true,
			implementation: "off",
			explicit: true,
		});
		expect(readSwitch("clock", { HERD_CLOCK: "on" })).toEqual({
			ok: true,
			implementation: "on",
			explicit: true,
		});
	});

	test("an unknown name form is refused with what is available", () => {
		expect(readSwitch("clock", { HERD_CLOCK: "paused" })).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "clock",
			wanted: "paused",
			available: ["on", "off"],
		});
	});

	test("the name form wins over the legacy disable flag", () => {
		expect(readSwitch("clock", { HERD_CLOCK: "on", HERD_DISABLE_CLOCK: "1" })).toEqual({
			ok: true,
			implementation: "on",
			explicit: true,
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
		const resolved = resolvePorts({}, { HERD_CLOCK: "off" });
		expect(resolved.ok).toBe(true);
		expect(Object.hasOwn(resolved.ports, "scope")).toBe(false);
		expect(Object.hasOwn(resolved.ports, "relay")).toBe(false);
		expect(resolved.ports.clock).toBe("off");
	});

	test("a stale scope or relay request is refused as an unknown port", () => {
		expect(resolvePorts({ scope: "bare" }, EMPTY)).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "scope",
			wanted: "bare",
			available: [],
		});
		expect(resolvePorts({ relay: "handoff" }, EMPTY)).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "relay",
			wanted: "handoff",
			available: [],
		});
	});

	test("a ticket may pick another implementation when the environment said nothing", () => {
		const resolved = resolvePorts({ clock: "off" }, EMPTY);
		expect(resolved.ok).toBe(true);
		expect(resolved.ports.clock).toBe("off");
	});

	test("an explicit environment choice beats the ticket", () => {
		expect(resolvePorts({ clock: "off" }, { HERD_CLOCK: "on" })).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "clock",
			wanted: "off",
			available: ["on"],
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
