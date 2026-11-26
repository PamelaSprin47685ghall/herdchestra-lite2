// The session-stop gate owns two rules. An aborted turn or an errored
// assistant message is not a user request to stop the relay. An aborted turn
// is, however, the user ending the branch: every descendant is cancelled
// before the gate returns. These cases pin both rules at the station.

import { describe, expect, test } from "bun:test";

import { onSessionStop } from "../src/station/gates.mjs";

function station(recorded) {
	return {
		state: { autopilot: true, relay: { canStop: false, handoffPending: false } },
		relayOn: () => true,
		recordNaturalStop: () => {
			recorded.push("stopped");
		},
		cancelDescendants: () => {
			recorded.push("cancelled");
		},
	};
}

describe("session stop evidence", () => {
	const cases = [
		// Host stop evidence is never a user-abort proof. USER_ABORT is a typed
		// first-class input at the abort entry; these frames only describe how
		// the model loop ended.
		["an aborted stop reason", { reason: "aborted" }, []],
		["an error stop reason", { reason: "error" }, []],
		["an aborted signal", { signal: { aborted: true }, reason: "stop" }, []],
		["a tool interrupt", { signal: { aborted: true, reason: Symbol.for("pi-agent-core.tool-interrupt") }, reason: "stop" }, []],
		["a normal stop", { reason: "stop", signal: { aborted: false } }, ["stopped"]],
		["no evidence at all", null, ["stopped"]],
	];

	for (const [name, evidence, expected] of cases) {
		test(name, () => {
			const recorded = [];
			const result = onSessionStop(station(recorded), {}, evidence);

			expect(recorded).toEqual(expected);
			expect(result).toBeUndefined();
		});
	}
});
