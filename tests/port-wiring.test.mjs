import { expect, test } from "bun:test";
import { createTestStation } from "./helpers/station-ports.mjs";

import { wireProviderObservation } from "../host-omp/src/host/provider-observer.mjs";
import { installStatus } from "../host-omp/src/host/status.mjs";
import { queueModelSwitch, takePendingModelSwitch } from "../src/station/models.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { buildPorts } from "../src/core/ports/build.mjs";
import { defaultFeatures } from "../src/features/herd/features.mjs";
import { createEngine } from "herdchestra-lite2";
import { createStationRegistry } from "../src/station/registry.mjs";
import { wireCommands } from "../host-omp/src/activation/commands.mjs";
import { createState, deserializeState, serializeState } from "../src/scope/index.mjs";

const PORT_ENV = {
	clock: "HERD_CLOCK",
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

test("the station binds one session port object, not one per call", () => {
	const built = buildPorts({ HERD_HERD: "on" });
	const station = createTestStation(SessionStation, 
		{ getSessionId: () => "s1" },
		{},
		{},
		{ ports: () => built.names, implementations: () => built.implementations },
		null,
	);
	const first = station.herdPort();
	expect(first).toBe(station.herdPort());
	expect(first.toggle("hi")).toEqual({ ok: true, mode: "on", text: "hi" });
	expect(station.state.relay?.goal === true).toBe(true);
});

test("herd off refuses a toggle and never flips the persisted mode", () => {
	const station = stationWith({ herd: "off" }, { features: defaultFeatures() });
	expect(station.herdPort().toggle("hi")).toEqual({
		ok: false,
		code: "HERD_UNAVAILABLE",
		port: "herd",
	});
	expect(station.state.relay?.goal === true).toBe(false);
});

test("herd on flips the persisted mode and reports it", () => {
	const station = stationWith({ herd: "on" }, { features: defaultFeatures() });
	const first = station.herdPort().toggle("hi");
	expect(first).toEqual({ ok: true, mode: "on", text: "hi" });
	expect(station.state.relay?.goal === true).toBe(true);
	const second = station.herdPort().toggle("");
	expect(second).toEqual({ ok: true, mode: "off", text: "" });
	expect(station.state.relay?.goal === true).toBe(false);
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
	station.state.relay.goal = false;
	expect(station.herdPort()).toBe(station.herdPort());
	expect(station.herdPort().toggle("hi").ok).toBe(true);
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

test("features start at their defaults and survive a persist round trip", () => {
	const fresh = createState();
	expect(fresh.features).toEqual(defaultFeatures());
	expect(fresh.features.testing).toBe("lean");

	fresh.features.testing = "no-red";
	fresh.relay.goal = true;
	const restored = deserializeState(serializeState(fresh));
	expect(restored.features.testing).toBe("no-red");
	expect(restored.relay.goal).toBe(true);

	const legacy = serializeState(fresh);
	delete legacy.features;
	delete legacy.relay;
	legacy.autopilot = true;
	const migrated = deserializeState(legacy);
	// The retired switch is dropped, never reopened as a goal session.
	expect(migrated.features.autopilot).toBeUndefined();
	expect(migrated.relay?.goal === true).toBe(false);
	expect(migrated.features.testing).toBe("lean");
});

test("the command table registers one bare herd command", async () => {
	const commands = new Map();
	const calls = [];
	const pi = {
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
	};
	wireCommands(pi, {
		stationFor: () => ({
			onHerdCommand(args) {
				calls.push(args);
				return { ok: true };
			},
		}),
	});

	expect(commands.has("herd")).toBe(true);
	expect(commands.has("herd-goal")).toBe(true);
	expect(commands.has("herd-autopilot")).toBe(false);
	const result = await commands.get("herd").handler("testing off note this");
	expect(result).toEqual({ ok: true });
	expect(calls).toEqual(["testing off note this"]);
});

test("one bare command sets a feature and sends optional text once", () => {
	const prompts = [];
	const station = createTestStation(SessionStation, 
		{ getSessionId: () => "s1" },
		{},
		{ canPrompt: true, prompt: (text) => prompts.push(text) },
		{ ports: () => ({ herd: "on" }) },
		null,
	);

	expect(station.state.features.testing).toBe("lean");
	const on = station.onHerdCommand("testing no-red hello");
	expect(on).toMatchObject({ ok: true, kind: "set", feature: "testing", state: "no-red", text: "hello" });
	expect(station.state.features.testing).toBe("no-red");
	expect(prompts).toEqual(["hello"]);

	const off = station.onHerdCommand("testing off");
	expect(off).toMatchObject({ ok: true, kind: "set", feature: "testing", state: "off" });
	expect(station.state.features.testing).toBe("off");
	expect(prompts).toEqual(["hello"]);

	// The retired switch is refused, never silently ignored.
	expect(station.onHerdCommand("autopilot on")).toMatchObject({
		ok: false,
		code: "UNKNOWN_FEATURE",
	});
});

test("one goal command starts goal mode and delivers the instruction once", () => {
	const prompts = [];
	const station = createTestStation(SessionStation,
		{ getSessionId: () => "s1" },
		{},
		{ canPrompt: true, prompt: (text) => prompts.push(text) },
		{ ports: () => ({ herd: "on" }) },
		null,
	);

	// A bare command releases goal mode, and pressing it twice is a no-op.
	expect(station.onGoalCommand("  ")).toMatchObject({ ok: true, kind: "off", goal: false });
	expect(prompts).toEqual([]);

	const started = station.onGoalCommand("do x");
	expect(started).toMatchObject({ ok: true, kind: "goal", text: "do x" });
	expect(station.state.relay.goal).toBe(true);
	expect(station.state.relay.canStop).toBe(false);
	expect(prompts).toEqual(["do x"]);

	const released = station.onGoalCommand("");
	expect(released).toMatchObject({ ok: true, kind: "off", goal: false });
	expect(station.state.relay.goal).toBe(false);
	expect(station.onGoalCommand("")).toMatchObject({
		ok: true,
		kind: "off",
		message: "goal mode is already off",
	});
	expect(prompts).toEqual(["do x"]);

	expect(station.onGoalCommand("again").kind).toBe("goal");
	expect(station.endGoalSession()).toBe(true);
	expect(station.state.relay.goal).toBe(false);
	expect(station.endGoalSession()).toBe(false);
});

test("an interrupted turn keeps goal mode on until a bare command or the sealed delivery", () => {
	const station = createTestStation(SessionStation,
		{ getSessionId: () => "s1" },
		{},
		{ canPrompt: true, prompt: () => {} },
		{ ports: () => ({ herd: "on" }) },
		null,
	);
	station.onGoalCommand("do x");

	// Esc aborts the turn: the host reports an aborted stop, so no nudge runs
	// and the goal flag survives.
	expect(station.state.relay.goal).toBe(true);
	expect(station.state.relay.canStop).toBe(false);
	expect(
		station.onSessionStop({}, { reason: "aborted", signal: { aborted: true } }),
	).toBeUndefined();
	expect(station.state.relay.goal).toBe(true);

	// A plain stop mid-goal is redirected to scope_return, never a silent exit.
	expect(station.onSessionStop({}, null)).toBeDefined();
	expect(station.state.relay.goal).toBe(true);

	// Only the sealed delivery releases the session.
	station.state.relay.canStop = true;
	expect(station.onSessionStop({}, null)).toBeUndefined();
	expect(station.state.relay.goal).toBe(false);
});

test("a refused port or feature switch throws at the composition root", () => {
	// An empty table would wire every port to its fallback and hide the typo.
	// The engine owns port resolution now, so the refusal surfaces there.
	expect(() => createEngine({ host: {}, tickets: {}, env: { HERD_CLOCK: "bogus" } })).toThrow(
		/PORT_UNAVAILABLE port=clock wanted=bogus/,
	);
	expect(() => createEngine({ host: {}, tickets: {}, env: { HERD_TESTING: "maybe" } })).toThrow(
		/INVALID_FEATURE_STATE feature=testing/,
	);
});

test("the registry accepts one wiring shape and refuses a flat name table", () => {
	const tickets = { steer() {}, prompt() {} };
	expect(() =>
		createStationRegistry({ tickets, clock: "on" }),
	).toThrow(/LEGACY_PORTS_SHAPE/);
});

test("the registry is frozen and exposes the port table once", () => {
	const tickets = { steer() {}, prompt() {} };
	const built = buildPorts({});
	const registry = createStationRegistry({ tickets,
		ports: built.names,
		implementations: built.implementations,
	});
	expect(Object.isFrozen(registry)).toBe(true);
	const first = registry.implementations();
	expect(first).toBe(registry.implementations());
	expect(Object.isFrozen(first)).toBe(true);
	expect(first.clock).toBe(built.implementations.clock);
});
