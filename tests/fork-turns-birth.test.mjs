// A scope_fork child must be able to spend the turns it declared.
//
// The consumer of this contract is the child branch: it calls a normal tool and
// the host runs it, charging the declared turns and recording an overrun.
// The parent's consumer view is the fork receipt, which must name the same
// turns the ledger will charge.

import { describe, expect, test } from "bun:test";

import { chargeBranch } from "../src/scope/accounting.mjs";
import { createBracketLedger, forkOf } from "../src/scope/forkjoin.mjs";
import { handleForkCall } from "../src/station/fork-controls.mjs";
import { onToolCall } from "../src/station/gates.mjs";
import { createState } from "../src/scope/state.mjs";

function stationWith(ledger, spawned = []) {
	return {
		state: createState(),
		forkLedgerPort: () => ledger,
		childSpawnPort: () => (spec) => spawned.push(spec),
	};
}

function forkOne(station, overrides = {}) {
	return handleForkCall(station, {
		id: "fork-call",
		arguments: {
			forks: [
				{
					scopeId: "parser",
					fsm: "read the parser",
					profession: "You are a careful parser reader like Ada Lovelace.",
					budget: { read: 2, bash: 1 },
					targets: ["src/parser.mjs"],
					...overrides,
				},
			],
		},
	});
}

/** The gate a child branch runs before any normal tool executes. */
function childGate(ledger, forkId) {
	const station = {
		state: createState(),
		forkLedgerPort: () => ledger,
		forkOwnerId: () => forkId,
		policy: () => "read-write-subagent",
		persist: () => {},
		processControlsForTool: () => {},
		assistantForToolCall: () => null,
		messageForToolCall: () => undefined,
		dispatch: { groupKeyFor: () => null, rememberGroups: () => {} },
		noteError: () => {},
	};
	return (toolCallId, toolName) =>
		onToolCall(station, { toolCallId, toolName, input: {} }, {
			sessionManager: { getBranch: () => [] },
		});
}

describe("a child is born with the budget it declared", () => {
	test("the ledger charges the child's first normal tool call", () => {
		const ledger = createBracketLedger();
		const spawned = [];
		const station = stationWith(ledger, spawned);
		const out = forkOne(station);
		expect(out.isError).toBeUndefined();
		expect(spawned).toHaveLength(1);

		const record = forkOf(ledger, "fork-call");
		expect(record).not.toBeNull();

		const charged = chargeBranch(station.state, ledger, {
			ownerId: "fork-call",
			toolCallId: "child-read-1",
			toolName: "read",
			beatTools: [{ name: "read", free: false }],
		});
		expect(charged.ok).toBe(true);
		expect(charged.amount).toBe(1);
		expect(record.remaining.read).toBe(1);
		expect(record.spent.read).toBe(1);
		expect(station.state.charges["child-read-1"]).toEqual({
			ownerId: "fork-call",
			tool: "read",
			amount: 1,
		});
	});

	test("budget and remaining start identical, after tool-name normalization", () => {
		const ledger = createBracketLedger();
		const station = stationWith(ledger, []);
		forkOne(station, { budget: { apply_patch: 2, read: 1 } });
		const record = forkOf(ledger, "fork-call");
		expect(record.budget).toEqual({ edit: 2, read: 1 });
		expect(record.remaining).toEqual(record.budget);
		expect(record.spent).toEqual({ edit: 0, read: 0 });
	});

	test("a fork's budget is the one it declared", () => {
		const ledger = createBracketLedger();
		const spawned = [];
		const station = stationWith(ledger, spawned);
		forkOne(station, { budget: { read: 3 } });
		expect(spawned).toHaveLength(1);
		const record = forkOf(ledger, "fork-call");
		expect(record.status).toBe("running");
		expect(record.budget).toEqual({ read: 3 });
	});
});

describe("an overrun is recorded, not refused", () => {
	test("an exhausted child budget marks the tool on the child's record", () => {
		const ledger = createBracketLedger();
		const station = stationWith(ledger, []);
		forkOne(station, { budget: { read: 0 } });
		const charged = chargeBranch(station.state, ledger, {
			ownerId: "fork-call",
			toolCallId: "child-read-1",
			toolName: "read",
		});
		expect(charged.ok).toBe(true);
		expect(charged.panhandled).toBe(true);
		const record = forkOf(ledger, "fork-call");
		expect(record.panhandles.map((entry) => entry.tool)).toEqual(["read"]);
	});

	test("the host-facing gate runs an exhausted call instead of blocking it", () => {
		const ledger = createBracketLedger();
		const station = stationWith(ledger, []);
		forkOne(station, { budget: { read: 0 } });
		const gate = childGate(ledger, "fork-call");
		const verdict = gate("child-read-1", "read");
		expect(verdict?.block).toBeUndefined();
		const record = forkOf(ledger, "fork-call");
		expect(record.panhandles.map((entry) => entry.tool)).toEqual(["read"]);
	});
});
