// A scope_fork child must be able to spend the budget it declared.
//
// The consumer of this contract is the child branch: it calls a normal tool
// and the host either runs it or refuses with a stated reason. The parent's
// consumer view is the fork receipt, which must name the same budget the
// ledger will charge.

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
					knuth_nfa_inspired_fsm: "read the parser",
					blocked: false,
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

	test("a blocked plan records its budget but owns no running account", () => {
		const ledger = createBracketLedger();
		const spawned = [];
		const station = stationWith(ledger, spawned);
		forkOne(station, { blocked: true, budget: { read: 3 } });
		expect(spawned).toHaveLength(0);
		const record = forkOf(ledger, "fork-call");
		expect(record.status).toBe("blocked");
		expect(record.budget).toEqual({ read: 3 });
	});
});

describe("a refusal always states why", () => {
	test("an exhausted child budget names the tool and the balance", () => {
		const ledger = createBracketLedger();
		const station = stationWith(ledger, []);
		forkOne(station, { budget: { read: 0 } });
		const refused = chargeBranch(station.state, ledger, {
			ownerId: "fork-call",
			toolCallId: "child-read-1",
			toolName: "read",
		});
		expect(refused.ok).toBe(false);
		expect(refused.code).toBe("BUDGET_EXHAUSTED");
		expect(typeof refused.reason).toBe("string");
		expect(refused.reason.length).toBeGreaterThan(0);
		expect(refused.reason).toContain("read");
	});

	test("the host-facing gate never blocks without a reason", () => {
		const ledger = createBracketLedger();
		const station = stationWith(ledger, []);
		forkOne(station, { budget: { read: 0 } });
		const gate = childGate(ledger, "fork-call");
		const verdict = gate("child-read-1", "read");
		expect(verdict?.block).toBe(true);
		expect(typeof verdict.reason).toBe("string");
		expect(verdict.reason.length).toBeGreaterThan(0);
		expect(verdict.reason).toContain("read");
	});
});
