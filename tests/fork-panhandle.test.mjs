// A branch that runs out still works. Its turns are a ledger, not a fence.
//
// The consumer of this contract is the child branch: a paid tool whose turns
// are gone is not refused, it runs, and the record admits the overrun. The
// parent's consumer view is the turns line: `panhandled Nx`, which the record
// carries when the branch returns. The root keeps its refusal, because the root
// is outside every scope and has no branch record to overrun.

import { describe, expect, test } from "bun:test";

import { createState } from "../src/scope/state.mjs";
import {
	createBracketLedger,
	createClockOn,
	forkBudgetText,
	forkOf,
	registerFork,
} from "../src/scope/index.mjs";
import { onToolCall } from "../src/station/gates.mjs";

const NOW = 1_700_000_000_000;

function branch(ledger, overrides = {}) {
	const registered = registerFork(
		ledger,
		{
			forkId: "worker",
			ownerId: "root",
			fsm: "finish the report",
			depth: 0,
			startedAt: NOW,
			budget: { read: 0 },
			time: 60,
			...overrides,
		},
		{ clock: createClockOn() },
	);
	if (!registered.ok) throw new Error(registered.code);
	return registered.fork;
}

function stationWith(ledger, forkId) {
	return {
		state: createState(),
		forkLedgerPort: () => ledger,
		forkOwnerId: () => forkId,
		branchRecord: () => (forkId ? forkOf(ledger, forkId) : null),
		clockPort: () => createClockOn(),
		policy: () => "read-write-subagent",
		persist: () => true,
		processControlsForTool: () => {},
		assistantForToolCall: () => null,
		messageForToolCall: () => undefined,
		rememberToolGate: () => {},
		noteError: () => {},
	};
}

function gate(station) {
	return (toolCallId, toolName, input = {}) =>
		onToolCall(station, { toolCallId, toolName, input }, {
			sessionManager: { getBranch: () => [] },
		});
}

describe("a call that outruns its turns still runs", () => {
	test("the paid tool passes the gate, spends nothing, and lands in the panhandle count", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, { budget: { read: 0 } });
		const admit = gate(stationWith(ledger, "worker"));

		expect(admit("read-1", "read")).toBeUndefined();
		expect(record.remaining.read).toBe(0);
		expect(record.spent.read).toBe(0);
		expect(record.panhandles).toHaveLength(1);
		expect(record.panhandles[0].tool).toBe("read");
		// The overrun is what the caller reads, not a silent free call.
		expect(forkBudgetText(record, NOW)).toContain("panhandled 1x");
	});

	test("a tool the fork never granted turns panhandles the same way", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, { budget: { read: 1 } });
		const admit = gate(stationWith(ledger, "worker"));

		expect(admit("edit-1", "edit")).toBeUndefined();
		expect(record.panhandles.map((entry) => entry.tool)).toEqual(["edit"]);
	});

	test("the budget bottoms out at zero and never goes negative", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, { budget: { read: 1 } });
		const admit = gate(stationWith(ledger, "worker"));

		expect(admit("read-1", "read")).toBeUndefined();
		expect(record.remaining.read).toBe(0);
		expect(admit("read-2", "read")).toBeUndefined();
		expect(record.remaining.read).toBe(0);
		expect(record.spent.read).toBe(1);
		expect(record.panhandles).toHaveLength(1);
	});

	test("a retry of the same call is not a second admission", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, { budget: { read: 0 } });
		const station = stationWith(ledger, "worker");
		const admit = gate(station);

		expect(admit("read-1", "read")).toBeUndefined();
		station.rememberToolGate = () => {};
		expect(admit("read-1", "read")).toBeUndefined();
		expect(record.panhandles).toHaveLength(1);
	});

	test("a free tool never reaches the panhandle count", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, { budget: { read: 0 } });
		const admit = gate(stationWith(ledger, "worker"));

		expect(admit("todo-1", "todo")).toBeUndefined();
		expect(admit("read-1", "read", { path: "local://notes.md" })).toBeUndefined();
		expect(record.panhandles).toBeUndefined();
	});
});

describe("the root is outside every scope and keeps its refusal", () => {
	test("an ordinary tool at the root is blocked, and the block says why", () => {
		const ledger = createBracketLedger();
		const refused = gate(stationWith(ledger, null))("read-1", "read");

		expect(refused?.block).toBe(true);
		expect(typeof refused.reason).toBe("string");
		expect(refused.reason.length).toBeGreaterThan(0);
	});

	test("a branch that is not in the ledger is blocked, not panhandled", () => {
		const ledger = createBracketLedger();
		const station = stationWith(ledger, "worker");
		const refused = gate(station)("read-1", "read");

		expect(refused?.block).toBe(true);
		expect(refused.reason).toContain("worker");
	});
});
