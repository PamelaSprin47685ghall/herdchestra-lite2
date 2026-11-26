// A native todo call is free even while a fork result is outstanding.

import { describe, expect, test } from "bun:test";

import { onToolCall } from "../src/station/gates.mjs";
import { createBracketLedger, registerFork } from "../src/scope/index.mjs";

function stationWith(children, { ownerId = "root", viewer = null } = {}) {
	const ledger = createBracketLedger();
	for (const forkId of children) {
		registerFork(ledger, {
			forkId,
			ownerId,
			levelKey: `${ownerId}|0|0`,
			fsm: `child ${forkId}`,
			depth: 0,
			blocked: false,
		});
	}
	return {
		state: { scopes: [], autopilot: true },
		processed: { hasHandled: () => true, markCall: () => {} },
		processControlsForTool: () => {},
		forkLedgerPort: () => ledger,
		forkOwnerId: () => viewer,
		persist: () => {},
		policy: () => "main",
		registry: { ports: () => ({}) },
	};
}

function todoEvent() {
	return {
		toolName: "todo",
		toolCallId: "call_todo",
		input: { op: "init", list: [] },
	};
}

describe("todo with unreceived fork results", () => {
	test("does not refuse the tool while a fork has not been received", () => {
		const station = stationWith(["fork_a"]);
		const verdict = onToolCall(station, todoEvent(), {});
		expect(verdict).toBeUndefined();
	});

	test("allows native todo when no child is outstanding", () => {
		const station = stationWith([]);
		const verdict = onToolCall(station, todoEvent(), {});
		expect(verdict).toBeUndefined();
	});

	test("allows a child's todo even while that child owns an unreceived grandchild", () => {
		const station = stationWith(["grand"], { ownerId: "fork_a", viewer: "fork_a" });
		const verdict = onToolCall(station, todoEvent(), {});
		expect(verdict).toBeUndefined();
	});
});
