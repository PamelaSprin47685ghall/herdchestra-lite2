// The session-stop gate owns the stop rules:
// - An aborted turn or an errored assistant message never triggers a stop nudge.
// - A Root turn that just triggered/is running a rewind never triggers a stop nudge.
// - Unreceived children outrank everything else (`scope_join`).
// - A running child is nudged to call `scope_return` within its shared allowance.
// - Root under autopilot is nudged to call `scope_return` until `canStop === true`.

import { describe, expect, test } from "bun:test";

import { onSessionStop } from "../src/station/gates.mjs";
import { defaultFeatures } from "../src/features/herd/features.mjs";
import { rootReturnNudge } from "../src/station/texts.mjs";

import { SessionStation } from "../src/station/station.mjs";

function station(overrides = {}) {
	const stateOverrides = overrides.state ?? {};
	const features = {
		...defaultFeatures(),
		...(stateOverrides.features ?? {}),
	};
	const relay = { goal: stateOverrides.autopilot !== false, canStop: false, pendingRewind: null, ...(overrides.relay ?? {}) };
	// The rewind facts and the methods that own them come from the station
	// itself: a double that re-implemented them would test its own copy.
	const station = Object.assign(Object.create(SessionStation.prototype), {
		state: {
			...stateOverrides,
			features,
			relay,
		},
		forkOwnerId: () => overrides.ownerId ?? null,
		forkLedgerPort: () => overrides.ledger ?? null,
		// The stop gate asks the station for its mode; a stub answers with the
		// one fact the rule reads.
		projectionFor: () => ({
			mode:
				overrides.mode ??
				(relay.goal === true ? "ROOT_AUTOPILOT" : "ROOT_MANUAL"),
		}),
	});
	station.rewind = {
		pendingChild: null,
		childAvailable: true,
		rewoundThisTurn: overrides.rewoundThisTurn ?? false,
		dispatching: null,
		modelSwitch: null,
		modelSwitchInFlight: null,
	};
	return station;
}

describe("session stop evidence", () => {
	const silentCases = [
		["an aborted stop reason", { reason: "aborted" }],
		["an error stop reason", { reason: "error" }],
		["an aborted signal", { signal: { aborted: true }, reason: "stop" }],
		["a tool interrupt", { signal: { aborted: true, reason: Symbol.for("pi-agent-core.tool-interrupt") }, reason: "stop" }],
	];

	for (const [name, evidence] of silentCases) {
		test(name, () => {
			expect(onSessionStop(station(), {}, evidence)).toBeUndefined();
		});
	}

	test("a normal stop under autopilot before two oaths nudges scope_return", () => {
		for (const evidence of [{ reason: "stop", signal: { aborted: false } }, null]) {
			const result = onSessionStop(station(), {}, evidence);
			expect(result).toEqual({
				continue: true,
				additionalContext: rootReturnNudge(),
			});
		}
	});

	test("a normal stop when canStop is true or autopilot is off is allowed", () => {
		expect(onSessionStop(station({ relay: { canStop: true } }), {}, null)).toBeUndefined();
		expect(onSessionStop(station({ state: { autopilot: false } }), {}, null)).toBeUndefined();
	});

	test("a root turn with rewoundThisTurn or pendingRewind is never double-nudged", () => {
		const rewound = station({ rewoundThisTurn: true });
		expect(onSessionStop(rewound, {}, null)).toBeUndefined();
		expect(rewound.rewind.rewoundThisTurn).toBe(false);

		const pending = station({ relay: { pendingRewind: { report: "r", big: false, generation: 1 } } });
		expect(onSessionStop(pending, {}, null)).toBeUndefined();
	});
});
