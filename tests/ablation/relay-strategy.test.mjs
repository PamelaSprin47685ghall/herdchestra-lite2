// Red contract for Phase 3 B2: the relay is a policy object, not a string.
//
// The proof is behavioral: the station registry is given contradictory answers
// on purpose. `ports().relay` says one thing and `implementations().relay` holds
// the other object. A production path that still reads the string fails; a path
// that calls the object passes.

import { describe, expect, test } from "bun:test";
import { createTestStation } from "../helpers/station-ports.mjs";
import { readFileSync } from "node:fs";

import {
	relayHandoff,
	relayImplementations,
	relayLedger,
	relayNone,
} from "../../src/relay/policy.mjs";
import { createRelay } from "../../src/relay/index.mjs";
import {
	armHandoff,
	recordLedgerEvaluation,
} from "../../src/station/handoff-state.mjs";
import { SessionStation } from "../../src/station/station.mjs";

const OPEN = { empty: false, open: 3, total: 5 };
const EMPTY = { empty: true, open: 0, total: 5 };
const WORK = [{ phase: "Work", items: ["one"] }];

describe("relay policy objects", () => {
	test("the three levels share a method set and differ only in obligation", () => {
		expect(Object.keys(relayImplementations).sort()).toEqual([
			"handoff",
			"ledger",
			"none",
		]);
		for (const [name, impl] of Object.entries(relayImplementations)) {
			expect(impl.name).toBe(name);
			for (const method of [
				"record",
				"status",
				"advance",
				"owesLedger",
				"canHandoff",
			]) {
				expect(typeof impl[method]).toBe("function");
			}
		}

		expect(relayNone.owesLedger()).toBe(false);
		expect(relayNone.canHandoff()).toBe(false);
		expect(relayLedger.owesLedger()).toBe(true);
		expect(relayLedger.canHandoff()).toBe(false);
		expect(relayHandoff.owesLedger()).toBe(true);
		expect(relayHandoff.canHandoff()).toBe(true);
	});

	test("none records nothing, owes nothing, and refuses to advance", () => {
		expect(relayNone.record(OPEN)).toEqual({ ok: true, recorded: false });
		expect(relayNone.status()).toMatchObject({
			kind: "none",
			owes: false,
			canStop: true,
			ledger: null,
		});
		expect(relayNone.advance(EMPTY)).toMatchObject({
			ok: false,
			code: "RELAY_NOT_OWED",
		});
	});

	test("ledger records a ledger, stops only when it is empty, never hands off", () => {
		expect(relayLedger.record(OPEN)).toEqual({
			ok: true,
			recorded: true,
			ledger: OPEN,
		});
		expect(relayLedger.status(OPEN)).toMatchObject({
			kind: "ledger",
			owes: true,
			canStop: false,
		});
		expect(relayLedger.status(EMPTY)).toMatchObject({
			kind: "ledger",
			owes: true,
			canStop: true,
		});
		expect(relayLedger.advance(EMPTY)).toMatchObject({
			ok: false,
			code: "RELAY_NO_HANDOFF",
		});
	});

	test("handoff adds the transfer only for an empty ledger", () => {
		expect(relayHandoff.record(OPEN)).toEqual({
			ok: true,
			recorded: true,
			ledger: OPEN,
		});
		expect(relayHandoff.advance(EMPTY)).toEqual({
			ok: true,
			kind: "handoff",
			next: "successor",
		});
		expect(relayHandoff.advance(OPEN)).toMatchObject({
			ok: false,
			code: "RELAY_LEDGER_OPEN",
		});
	});
});

function stationWith(relayObject, relayName) {
	const station = {
		state: { relay: createRelay() },
		persist() {},
		// The resolved object port is the one truth. The registry below still
		// carries the contradictory name, to prove the name is never read.
		relayPort: () => relayObject,
		registry: {
			ports: () => ({ relay: relayName }),
			implementations: () => ({ relay: relayObject }),
			markPending() {},
		},
		forkOwnerId: () => null,
		forkLedgerPort: () => null,
		handoffReport: null,
		markPending() {
			this.registry.markPending(this);
		},
		clearPending() {},
	};
	station.state.relay = {
		...station.state.relay,
		canStop: false,
		handoffPending: false,
	};
	return station;
}

describe("production calls the relay object", () => {
	test("a handoff object arms even when the string says none", () => {
		const station = stationWith(relayHandoff, "none");
		expect(armHandoff(station, {})).toBe(true);
		expect(station.state.relay.handoffPending).toBe(true);
	});

	test("a none object blocks arming even when the string says handoff", () => {
		const station = stationWith(relayNone, "handoff");
		expect(armHandoff(station, {})).toBe(false);
		expect(station.state.relay.handoffPending).toBe(false);
	});

	test("a none object ignores a ledger write even when the string says handoff", () => {
		const station = stationWith(relayNone, "handoff");
		const before = station.state.relay;
		const applied = recordLedgerEvaluation(station, WORK, "init");
		expect(applied.changed).toBe(false);
		expect(applied.action).toBeNull();
		expect(station.state.relay).toBe(before);
	});

	test("a ledger object applies a write even when the string says none", () => {
		const station = stationWith(relayLedger, "none");
		const applied = recordLedgerEvaluation(station, WORK, "init");
		expect(applied.changed).toBe(true);
		expect(station.state.relay.fullFlow).toBe(true);
	});
});

function stationWithImplementation(relayObject, relayName) {
	const station = createTestStation(SessionStation, 
		{ getSessionId: () => "s1" },
		{},
		{},
		{
			ports: () => ({ relay: relayName }),
			implementations: () => ({ relay: relayObject }),
		},
		null,
	);
	station.state.relay = createRelay();
	return station;
}

describe("station.relayOn calls the object", () => {
	test("a handoff object keeps the main agent on even when the string says none", () => {
		const station = stationWithImplementation(relayHandoff, "none");
		expect(station.relayPort()).toBe(relayHandoff);
		expect(station.relayOn({ agent: { kind: "main" } })).toBe(true);
	});

	test("a none object keeps the main agent off even when the string says handoff", () => {
		const station = stationWithImplementation(relayNone, "handoff");
		expect(station.relayPort()).toBe(relayNone);
		expect(station.relayOn({ agent: { kind: "main" } })).toBe(false);
		expect(station.relayReady()).toBe(false);
	});
});

test("neither handoff state nor the station compares the relay name", () => {
	const repo = new URL("../../", import.meta.url);
	for (const path of [
		"src/station/handoff-state.mjs",
		"src/station/station.mjs",
	]) {
		const text = readFileSync(new URL(path, repo), "utf8");
		expect(text).not.toMatch(/ports\?\.\(\)\.relay\s*===/);
	}
});
