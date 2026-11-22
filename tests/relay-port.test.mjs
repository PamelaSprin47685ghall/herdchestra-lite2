import { expect, test } from "bun:test";
import { createTestStation } from "./helpers/station-ports.mjs";

import { createRelay } from "../src/relay/index.mjs";
import { SessionStation } from "../src/station/station.mjs";

const WORK = Object.freeze([{ phase: "Work", items: ["one"] }]);
const EMPTY = Object.freeze([]);

function stationWith(relay) {
	const station = createTestStation(SessionStation, 
		{ getSessionId: () => "s1" },
		{},
		{},
		{ ports: () => ({ relay }) },
		null,
	);
	station.state.relay = createRelay();
	return station;
}

test("relay none ignores a ledger write and stays stoppable", () => {
	const station = stationWith("none");
	const applied = station.recordLedgerEvaluation(WORK, "init");
	expect(applied.changed).toBe(false);
	expect(applied.action).toBeNull();
	expect(station.state.relay.fullFlow).toBe(false);
});

test("relay none never arms a handoff", () => {
	const station = stationWith("none");
	station.state.relay = { ...station.state.relay, canStop: false, handoffPending: false };
	expect(station.armHandoff({})).toBe(false);
	expect(station.state.relay.handoffPending).toBe(false);
});

test("relay none turns the relay off for the main agent", () => {
	const station = stationWith("none");
	expect(station.relayOn({ agent: { kind: "main" } })).toBe(false);
	expect(station.relayReady()).toBe(false);
});

test("relay ledger records a ledger but never arms a handoff", () => {
	const station = stationWith("ledger");
	station.recordLedgerEvaluation(WORK, "init");
	expect(station.state.relay.fullFlow).toBe(true);
	station.state.relay = { ...station.state.relay, canStop: false };
	expect(station.armHandoff({})).toBe(false);
	expect(station.state.relay.handoffPending).toBe(false);
});

test("relay handoff keeps the transfer path", () => {
	const station = stationWith("handoff");
	station.recordLedgerEvaluation(WORK, "init");
	station.state.relay = { ...station.state.relay, canStop: false, handoffPending: false };
	expect(station.armHandoff({})).toBe(true);
	expect(station.state.relay.handoffPending).toBe(true);
});
