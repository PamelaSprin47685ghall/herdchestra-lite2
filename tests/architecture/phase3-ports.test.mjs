// Red contracts for Phase 3: delete the dead scope switch, make relay and the
// session ports real objects, and refuse a registry with no ticket capability.
//
// These tests are intentionally written before the implementation. They fail
// at import or assertion time until the named slices land; do not weaken them
// to make the current tree green.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
	NAMED_SWITCHES,
	PORT_NAMES,
	PORTS,
} from "../../src/core/ports/registry.mjs";
import { readSwitch, resolvePorts } from "../../src/core/ports/resolve.mjs";
import { buildPorts } from "../../src/core/ports/build.mjs";
import { createStationRegistry } from "../../src/station/registry.mjs";

const repo = new URL("../../", import.meta.url);

function source(path) {
	return readFileSync(new URL(path, repo), "utf8");
}

describe("B1 — the dead scope switch is deleted", () => {
	test("the port table no longer has a scope entry", () => {
		expect(PORTS.scope).toBeUndefined();
		expect(PORT_NAMES).not.toContain("scope");
		expect(NAMED_SWITCHES.has("scope")).toBe(false);
	});

	test("a stray HERD_SCOPE is ignored, not resolved", () => {
		const resolved = resolvePorts({}, { HERD_SCOPE: "bare" });
		expect(resolved.ok).toBe(true);
		expect(Object.hasOwn(resolved.ports, "scope")).toBe(false);

		const built = buildPorts({ HERD_SCOPE: "bare" });
		expect(built.ok).toBe(true);
		expect(Object.hasOwn(built.names, "scope")).toBe(false);
	});

	test("a ticket that still asks for scope is refused as an unknown port", () => {
		expect(resolvePorts({ scope: "bare" }, {})).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "scope",
			wanted: "bare",
			available: [],
		});
	});

	test("readSwitch no longer knows scope", () => {
		expect(readSwitch("scope", { HERD_SCOPE: "bare" })).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "scope",
			wanted: null,
			available: [],
		});
	});

	test("the smoke check no longer asks the resolver for a scope port", () => {
		expect(source("scripts/smoke-relay.mjs")).not.toContain('readSwitch("scope"');
	});
});

describe("B2/B5 — buildPorts carries the relay and session port objects", () => {
	test("relay resolves to a policy object, not a name", () => {
		const none = buildPorts({ HERD_RELAY: "none" });
		expect(none.ok).toBe(true);
		expect(none.implementations.relay.name).toBe("none");
		expect(none.implementations.relay.owesLedger()).toBe(false);
		expect(none.implementations.relay.canHandoff()).toBe(false);

		const handoff = buildPorts({ HERD_RELAY: "handoff" });
		expect(handoff.implementations.relay.name).toBe("handoff");
		expect(handoff.implementations.relay.owesLedger()).toBe(true);
		expect(handoff.implementations.relay.canHandoff()).toBe(true);
	});

	test("an invalid relay name is refused", () => {
		expect(buildPorts({ HERD_RELAY: "sometimes" })).toMatchObject({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "relay",
		});
	});

	test("pin/amend/herd are state-bound implementations built once", () => {
		const built = buildPorts({
			HERD_PIN: "off",
			HERD_AMEND: "on",
			HERD_HERD: "off",
		});
		expect(built.ok).toBe(true);
		for (const name of ["pin", "amend", "herd"]) {
			expect(typeof built.implementations[name]?.bindState).toBe("function");
		}

		const pin = built.implementations.pin.bindState({ pins: [] });
		expect(pin.add("note")).toEqual({
			ok: false,
			code: "PIN_UNAVAILABLE",
			port: "pin",
		});

		const amend = built.implementations.amend.bindState({ amends: [] });
		expect(amend.record("beat-1")).toEqual({
			ok: true,
			retired: ["beat-1"],
		});

		const herd = built.implementations.herd.bindState({ autopilot: false });
		expect(herd.toggle("hi")).toEqual({
			ok: false,
			code: "HERD_UNAVAILABLE",
			port: "herd",
		});
	});

	test("the on forms write through the store they are bound to", () => {
		const built = buildPorts({
			HERD_PIN: "on",
			HERD_AMEND: "on",
			HERD_HERD: "on",
		});
		const store = { pins: [], amends: [], autopilot: false };

		const pin = built.implementations.pin.bindState(store);
		expect(pin.add("note")).toEqual({ ok: true, count: 1 });
		expect(store.pins).toEqual(["note"]);

		const amend = built.implementations.amend.bindState(store);
		expect(amend.record("beat-1")).toEqual({
			ok: true,
			retired: ["beat-1"],
		});
		expect(store.amends).toEqual(["beat-1"]);

		const herd = built.implementations.herd.bindState(store);
		expect(herd.toggle("hi")).toEqual({ ok: true, mode: "on", text: "hi" });
		expect(store.autopilot).toBe(true);
	});
});

describe("B3 — missing tickets refuse before a station exists", () => {
	function recordingTickets() {
		const calls = [];
		return {
			calls,
			activateTools(...args) {
				calls.push(["activateTools", ...args]);
				return { systemPrompt: "ok" };
			},
			steer(...args) {
				calls.push(["steer", ...args]);
			},
			prompt(...args) {
				calls.push(["prompt", ...args]);
			},
			join(...args) {
				calls.push(["join", ...args]);
			},
			return(...args) {
				calls.push(["return", ...args]);
			},
		};
	}

	test("undefined or null tickets throw MISSING_TICKETS", () => {
		for (const tickets of [undefined, null]) {
			let error;
			try {
				createStationRegistry({ tickets });
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Error);
			expect(error.code ?? error.message).toContain("MISSING_TICKETS");
		}
	});

	test("a partial capability set is refused", () => {
		let error;
		try {
			createStationRegistry({ tickets: { activateTools() {} } });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error.code ?? error.message).toContain("MISSING_TICKETS");
	});

	test("a recording double is accepted and wired to the station", () => {
		const tickets = recordingTickets();
		const built = buildPorts({});
		const registry = createStationRegistry({ tickets,
			ports: built.names,
			implementations: built.implementations,
		});
		const station = registry.stationFor(null);
		expect(station.tickets).toBe(tickets);
	});

	test("a station bundle without every port is refused", () => {
		let error;
		try {
			createStationRegistry({ tickets: recordingTickets(),
				ports: {},
				implementations: { folding: {} },
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error.code).toBe("MISSING_PORTS");
		expect(error.missing).toContain("pin");
	});

	test("the silent no-op default is gone", () => {
		expect(source("src/station/registry.mjs")).not.toContain("nullTickets");
	});
});
