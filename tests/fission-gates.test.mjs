import { describe, expect, test } from "bun:test";

import { beginScope, createState } from "../src/scope/index.mjs";
import { onSessionStop, onToolCall } from "../src/station/gates.mjs";

const NESTED = {
	stage: "acceptance-cases",
	elder_report: null,
	fission: [{ intent: "inner", budget: { read: 1 }, permission: "ro" }],
};

/** A flow station with its scheduler-written scope already open. */
function flowStation() {
	const state = createState();
	const opened = beginScope(state, {
		toolCallId: "call-open",
		intent: "flow",
		stage: "architecture-design",
		budget: { read: 4 },
	});
	expect(opened.ok).toBe(true);
	return {
		state,
		fissionFlow: { id: "flow-a", permission: "ro" },
		// Admission of a legal begin must reach the stations that own the rest
		// of the call; this stub records that the gate did not stop it.
		deferScopePreflight: () => true,
	};
}

function scopeEvent(id, input) {
	return { toolName: "scope", toolCallId: id, input };
}

describe("fission flow scope admission", () => {
	test("requires an explicit end before a flow can stop", () => {
		const station = flowStation();
		station.relayOn = () => true;
		expect(onSessionStop(station, {}).additionalContext).toContain("scope({ end: true })");
		station.fissionFlow.endRequested = true;
		expect(onSessionStop(station, {})).toBeUndefined();
	});

	test("admits a nested batch begin from a flow", () => {
		const verdict = onToolCall(
			flowStation(),
			scopeEvent("call-nested", { begin: NESTED }),
			{},
		);

		expect(verdict).toBeUndefined();
	});

	test("admits a flow end before dispatch", () => {
		const verdict = onToolCall(
			flowStation(),
			scopeEvent("call-end", { end: true }),
			{},
		);

		expect(verdict).toBeUndefined();
	});

	test("refuses a flow begin that opens no batch", () => {
		const verdict = onToolCall(
			flowStation(),
			scopeEvent("call-begin", {
				begin: { intent: "own scope", stage: "architecture-design", budget: { read: 1 } },
			}),
			{},
		);

		expect(verdict?.block).toBe(true);
		expect(verdict.reason).toContain("SCOPE_UNAVAILABLE_IN_FISSION");
	});

	test("refuses a no-op end from a flow", () => {
		const verdict = onToolCall(
			flowStation(),
			scopeEvent("call-end-false", { end: false }),
			{},
		);

		expect(verdict?.block).toBe(true);
		expect(verdict.reason).toContain("SCOPE_UNAVAILABLE_IN_FISSION");
	});
});
