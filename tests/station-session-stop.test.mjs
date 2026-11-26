// The session-stop gate owns the stop rules:
// - An aborted turn or an errored assistant message never triggers a stop nudge.
// - A Root turn that just triggered/is running a rewind never triggers a stop nudge.
// - Unreceived children outrank everything else (`scope_join`).
// - A running child is nudged to call `scope_return` within its shared allowance.
// - Root under autopilot is nudged to call `scope_return` until `canStop === true`.

import { describe, expect, test } from "bun:test";

import { onSessionStop } from "../src/station/gates.mjs";
import { rootReturnNudge } from "../src/station/texts.mjs";

function station(overrides = {}) {
	return {
		state: {
			autopilot: true,
			relay: { canStop: false, pendingRewind: null, ...(overrides.relay ?? {}) },
			...(overrides.state ?? {}),
		},
		rewoundThisTurn: overrides.rewoundThisTurn ?? false,
		forkOwnerId: () => overrides.ownerId ?? null,
		forkLedgerPort: () => overrides.ledger ?? null,
	};
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
		expect(rewound.rewoundThisTurn).toBe(false);

		const pending = station({ relay: { pendingRewind: { report: "r", big: false, generation: 1 } } });
		expect(onSessionStop(pending, {}, null)).toBeUndefined();
	});
});
