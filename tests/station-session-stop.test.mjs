// The session-stop gate owns the rule that an aborted turn or an errored
// assistant message is not a user request to stop. The hook only forwards the
// evidence; these cases pin the decision at the station.

import { describe, expect, test } from "bun:test";

import { onSessionStop } from "../src/station/gates.mjs";

function station(recorded) {
	return {
		state: { autopilot: true, relay: { canStop: false, handoffPending: false } },
		relayOn: () => true,
		recordNaturalStop: () => {
			recorded.push("stopped");
		},
	};
}

describe("session stop evidence", () => {
	const cases = [
		["an aborted stop reason", { reason: "aborted" }, false],
		["an error stop reason", { reason: "error" }, false],
		["an aborted signal", { signal: { aborted: true }, reason: "stop" }, false],
		["a normal stop", { reason: "stop", signal: { aborted: false } }, true],
		["no evidence at all", null, true],
	];

	for (const [name, evidence, records] of cases) {
		test(name, () => {
			const recorded = [];
			const result = onSessionStop(station(recorded), {}, evidence);

			expect(recorded.length).toBe(records ? 1 : 0);
			expect(result).toBeUndefined();
		});
	}
});
