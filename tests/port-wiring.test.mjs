import { expect, test } from "bun:test";

import { wireProviderObservation } from "../src/host/provider-observer.mjs";
import { installStatus } from "../src/host/status.mjs";
import { queueModelSwitch, takePendingModelSwitch } from "../src/station/models.mjs";
import { SessionStation } from "../src/station/station.mjs";

function stationWith(ports, state = {}) {
	const station = new SessionStation({ getSessionId: () => "s1" }, {}, {}, { ports: () => ports }, null);
	Object.assign(station.state, state);
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
	const station = stationWith({ herd: "off" }, { herdMode: false });
	expect(station.herdPort().toggle("hi")).toEqual({
		ok: false,
		code: "HERD_UNAVAILABLE",
		port: "herd",
	});
	expect(station.state.herdMode).toBe(false);
});

test("herd on flips the persisted mode and reports it", () => {
	const station = stationWith({ herd: "on" }, { herdMode: false });
	const first = station.herdPort().toggle("hi");
	expect(first).toEqual({ ok: true, mode: "on", text: "hi" });
	expect(station.state.herdMode).toBe(true);
	const second = station.herdPort().toggle("");
	expect(second).toEqual({ ok: true, mode: "off", text: "" });
	expect(station.state.herdMode).toBe(false);
});

test("a missing registry keeps every port on", () => {
	const station = new SessionStation({ getSessionId: () => "s1" }, {}, {}, null, null);
	Object.assign(station.state, { pins: [], amends: [], herdMode: false });
	expect(station.pinPort().add("note").ok).toBe(true);
	expect(station.amendPort().record("beat-1").ok).toBe(true);
	expect(station.herdPort().toggle("").ok).toBe(true);
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
