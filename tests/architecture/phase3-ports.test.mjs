// Port registration and station capability contracts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
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
	});

	test("HERD_SCOPE is a feature env now, never a port", () => {
		const resolved = resolvePorts({}, { HERD_SCOPE: "aggressive" });
		expect(resolved.ok).toBe(true);
		expect(Object.hasOwn(resolved.ports, "scope")).toBe(false);

		const built = buildPorts({ HERD_SCOPE: "aggressive" });
		expect(built.ok).toBe(true);
		expect(Object.hasOwn(built.names, "scope")).toBe(false);
		expect(built.features.values.scope).toBe("aggressive");
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

describe("the old relay is not a port", () => {
	test("a stale relay switch is ignored at startup", () => {
		const built = buildPorts({ HERD_RELAY: "sometimes" });
		expect(built.ok).toBe(true);
		expect(Object.hasOwn(built.names, "relay")).toBe(false);
		expect(Object.hasOwn(built.implementations, "relay")).toBe(false);
	});

	test("an explicit relay request is refused as an unknown port", () => {
		expect(resolvePorts({ relay: "handoff" }, {})).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "relay",
			wanted: "handoff",
			available: [],
		});
	});
});

describe("B5 — buildPorts carries the session port objects", () => {
	test("herd is the one state-bound implementation, built once", () => {
		const built = buildPorts({ HERD_HERD: "off" });
		expect(built.ok).toBe(true);
		// `clock` is stateless, so it is the object itself; `herd` reads and
		// writes the station's state, so it is a binder.
		expect(typeof built.implementations.clock).toBe("object");
		expect(typeof built.implementations.herd?.bindState).toBe("function");

		const herd = built.implementations.herd.bindState({ relay: { goal: false } });
		expect(herd.toggle("hi")).toEqual({
			ok: false,
			code: "HERD_UNAVAILABLE",
			port: "herd",
		});
	});

	test("the on form writes through the store it is bound to", () => {
		const built = buildPorts({ HERD_HERD: "on" });
		const store = { relay: { goal: false } };

		const herd = built.implementations.herd.bindState(store);
		expect(herd.toggle("hi")).toEqual({ ok: true, mode: "on", text: "hi" });
		expect(store.relay.goal).toBe(true);
	});

	test("a retired pin or amend switch is refused, not silently ignored", () => {
		// Leaving the switches in the table would let an operator believe a
		// pin/amend feature still exists. The port is gone, so an explicit
		// request for it must fail loudly at the composition root.
		for (const port of ["pin", "amend"]) {
			const resolved = resolvePorts({ [port]: "on" }, {});
			expect(resolved.ok).toBe(false);
			expect(resolved.code).toBe("PORT_UNAVAILABLE");
			expect(resolved.port).toBe(port);
		}
	});
});

describe("B3 — missing tickets refuse before a station exists", () => {
	function recordingTickets() {
		const calls = [];
		return {
			calls,
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
			createStationRegistry({ tickets: { steer() {} } });
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
		expect(error.missing).toContain("clock");
	});

	test("the silent no-op default is gone", () => {
		expect(source("src/station/registry.mjs")).not.toContain("nullTickets");
	});
});
