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
		["an aborted stop reason", { reason: "aborted" }, ["cancelled"]],
		["an error stop reason", { reason: "error" }, []],
		["an aborted signal", { signal: { aborted: true }, reason: "stop" }, ["cancelled"]],
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
