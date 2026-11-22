import { expect, test } from "bun:test";
import { createTestStation } from "./helpers/station-ports.mjs";

import { wireProviderObservation } from "../src/host/provider-observer.mjs";
import { installStatus } from "../src/host/status.mjs";
import { queueModelSwitch, takePendingModelSwitch } from "../src/station/models.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { buildPorts } from "../src/activation/ports.mjs";
import { resolveWiringPorts } from "../src/activation/index.mjs";
import { createStationRegistry } from "../src/station/registry.mjs";
import { wireCommands } from "../src/activation/commands.mjs";
import { createState, deserializeState, serializeState } from "../src/scope/index.mjs";

const PORT_ENV = {
	folding: "HERD_FOLDING",
	clock: "HERD_CLOCK",
	relay: "HERD_RELAY",
	pin: "HERD_PIN",
	amend: "HERD_AMEND",
	herd: "HERD_HERD",
};

function stationWith(ports, state = {}) {
	const env = {};
	for (const [port, name] of Object.entries(ports)) {
		if (PORT_ENV[port]) env[PORT_ENV[port]] = name;
	}
	const built = buildPorts(env);
	const station = createTestStation(SessionStation, { getSessionId: () => "s1" }, {}, {}, { ports: () => ({ ...built.names, ...ports }), implementations: () => built.implementations }, null);
	// A port binder captures the arrays it was bound to. Keep those arrays and
	// fill them in place, the way restoreState does for a real session.
	for (const [key, value] of Object.entries(state)) {
		const current = station.state[key];
		if (Array.isArray(value) && Array.isArray(current)) {
			current.splice(0, current.length, ...value);
		} else {
			station.state[key] = value;
		}
	}
	return station;
}

test("pin off refuses every note and leaves the store untouched", () => {
	const station = stationWith({ pin: "off" }, { pins: [] });
	const result = station.pinPort().add("note");
	expect(result).toEqual({ ok: false, code: "PIN_UNAVAILABLE", port: "pin" });
	expect(station.state.pins).toEqual([]);
});

test("pin on writes through the station's persisted list", () => {
	const station = stationWith({ pin: "on" }, { pins: [] });
	expect(station.pinPort().add("note")).toEqual({ ok: true, count: 1 });
	expect(station.state.pins).toEqual(["note"]);
});

test("the station binds one session port object, not one per call", () => {
	const built = buildPorts({ HERD_PIN: "on" });
	const station = createTestStation(SessionStation, 
		{ getSessionId: () => "s1" },
		{},
		{},
		{ ports: () => built.names, implementations: () => built.implementations },
		null,
	);
	const first = station.pinPort();
	expect(first).toBe(station.pinPort());
	expect(first.add("note")).toEqual({ ok: true, count: 1 });
	expect(station.state.pins).toContain("note");
});

test("amend off refuses before applyAmend can mutate the ledger", () => {
	const station = stationWith({ amend: "off" }, { amends: [] });
	const result = station.amendPort().record("beat-1");
	expect(result).toEqual({ ok: false, code: "AMEND_UNAVAILABLE", port: "amend" });
	expect(station.state.amends).toEqual([]);
});

test("amend on records into the station's persisted list exactly once", () => {
	const station = stationWith({ amend: "on" }, { amends: [] });
	expect(station.amendPort().record("beat-1")).toEqual({ ok: true, retired: ["beat-1"] });
	expect(station.amendPort().record("beat-1")).toEqual({ ok: true, retired: ["beat-1"] });
	expect(station.state.amends).toEqual(["beat-1"]);
});

test("herd off refuses a toggle and never flips the persisted mode", () => {
	const station = stationWith({ herd: "off" }, { autopilot: false });
	expect(station.herdPort().toggle("hi")).toEqual({
		ok: false,
		code: "HERD_UNAVAILABLE",
		port: "herd",
	});
	expect(station.state.autopilot).toBe(false);
});

test("herd on flips the persisted mode and reports it", () => {
	const station = stationWith({ herd: "on" }, { autopilot: false });
	const first = station.herdPort().toggle("hi");
	expect(first).toEqual({ ok: true, mode: "on", text: "hi" });
	expect(station.state.autopilot).toBe(true);
	const second = station.herdPort().toggle("");
	expect(second).toEqual({ ok: true, mode: "off", text: "" });
	expect(station.state.autopilot).toBe(false);
});

test("a station without a complete bundle throws MISSING_PORTS", () => {
	expect(() =>
		new SessionStation({ getSessionId: () => "s1" }, {}, {}, null, null),
	).toThrow(/MISSING_PORTS/);
});

test("one complete bundle binds one object per station", () => {
	const station = createTestStation(
		SessionStation,
		{ getSessionId: () => "s1" },
		{},
		{},
		null,
		null,
	);
	Object.assign(station.state, { pins: [], amends: [], autopilot: false });
	expect(station.pinPort()).toBe(station.pinPort());
	expect(station.amendPort()).toBe(station.amendPort());
	expect(station.herdPort()).toBe(station.herdPort());
	expect(station.pinPort().add("note").ok).toBe(true);
});

test("status off binds no host event and builds no runtime", () => {
	const events = [];
	const pi = { on: (name) => events.push(name) };
	const runtime = installStatus(pi, { ports: { status: "off" } });
	expect(runtime).toEqual({ installed: false });
	expect(events).toEqual([]);
});

test("status on binds its widget events", () => {
	const events = [];
	const pi = { on: (name) => events.push(name) };
	const runtime = installStatus(pi, { ports: { status: "on" } });
	expect(runtime.installed).toBe(true);
	expect(events.length).toBeGreaterThan(0);
});

test("observer off binds no provider hook", () => {
	const events = [];
	const pi = { on: (name) => events.push(name) };
	const wired = wireProviderObservation(pi, {
		ports: () => ({ observer: "off" }),
		stationFor: () => ({}),
	});
	expect(wired).toEqual({ installed: false });
	expect(events).toEqual([]);
});

test("modelSwitch off never queues a switch", () => {
	const station = stationWith({ modelSwitch: "off" }, { epoch: 0 });
	queueModelSwitch(
		station,
		{ spec: "gpt-x", key: "gpt-x" },
		{ spec: "base", key: "base" },
		null,
	);
	expect(station.pendingModelSwitch).toBeNull();
	expect(takePendingModelSwitch(station, {})).toBe(null);
});

test("modelSwitch on queues the pending switch as before", () => {
	const station = stationWith({ modelSwitch: "on" }, { epoch: 0 });
	queueModelSwitch(
		station,
		{ spec: "gpt-x", key: "gpt-x" },
		{ spec: "base", key: "base" },
		null,
	);
	expect(station.pendingModelSwitch.targetSpec).toBe("gpt-x");
});

test("observer on binds both provider hooks", () => {
	const events = [];
	const pi = { on: (name) => events.push(name) };
	const wired = wireProviderObservation(pi, {
		ports: () => ({ observer: "on" }),
		stationFor: () => ({}),
	});
	expect(wired).toEqual({ installed: true });
	expect(events).toEqual(["before_provider_request", "after_provider_response"]);
});

test("autopilot is off in a fresh state and survives a persist round trip", () => {
	const fresh = createState();
	expect(fresh.autopilot).toBe(false);

	fresh.autopilot = true;
	expect(deserializeState(serializeState(fresh)).autopilot).toBe(true);

	const legacy = serializeState(fresh);
	delete legacy.autopilot;
	expect(deserializeState(legacy).autopilot).toBe(false);
});

test("the command table registers herd-autopilot and no bare herd", async () => {
	const commands = new Map();
	const calls = [];
	const pi = {
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
	};
	wireCommands(pi, {
		stationFor: () => ({
			onAutopilotCommand(args) {
				calls.push(args);
				return { ok: true };
			},
		}),
	});

	expect(commands.has("herd-autopilot")).toBe(true);
	expect(commands.has("herd")).toBe(false);
	const result = await commands.get("herd-autopilot").handler("note this");
	expect(result).toEqual({ ok: true });
	expect(calls).toEqual(["note this"]);
});

test("one bare command toggles autopilot and sends optional text once", () => {
	const prompts = [];
	const station = createTestStation(SessionStation, 
		{ getSessionId: () => "s1" },
		{},
		{ canPrompt: true, prompt: (text) => prompts.push(text) },
		{ ports: () => ({ herd: "on" }) },
		null,
	);

	expect(station.state.autopilot).toBe(false);
	const on = station.onAutopilotCommand("hello");
	expect(on).toEqual({ ok: true, mode: "on", text: "hello" });
	expect(station.state.autopilot).toBe(true);
	expect(prompts).toEqual(["hello"]);

	const off = station.onAutopilotCommand("");
	expect(off).toEqual({ ok: true, mode: "off", text: "" });
	expect(station.state.autopilot).toBe(false);
	expect(prompts).toEqual(["hello"]);
});

test("a refused port switch throws at the composition root", () => {
	// An empty table would wire every port to its fallback and hide the typo.
	expect(() => resolveWiringPorts({ HERD_RELAY: "bogus" })).toThrow(
		/PORT_UNAVAILABLE port=relay wanted=bogus/,
	);
});

test("the registry accepts one wiring shape and refuses a flat name table", () => {
	const tickets = { activateTools() {}, steer() {}, prompt() {} };
	expect(() =>
		createStationRegistry({}, tickets, null, { relay: "handoff" }),
	).toThrow(/LEGACY_PORTS_SHAPE/);
});

test("implementations() returns one frozen object, not a copy per read", () => {
	const tickets = { activateTools() {}, steer() {}, prompt() {} };
	const built = buildPorts({});
	const registry = createStationRegistry({}, tickets, null, {
		ports: built.names,
		implementations: built.implementations,
	});
	const first = registry.implementations();
	expect(first).toBe(registry.implementations());
	expect(Object.isFrozen(first)).toBe(true);
	expect(first.folding).toBe(built.implementations.folding);
	expect(first.clock).toBe(built.implementations.clock);
});
