// A branch that runs out must be able to buy its way to the next checkpoint.
//
// The consumer of this contract is the child branch: a paid tool is refused,
// the branch calls `scope_panhandle`, and the next paid tool runs. The parent's
// consumer view is the budget line: the grant raises both sides of the account
// and the clock, so a reload sees the same relief.

import { describe, expect, test } from "bun:test";

import { wireTools } from "../src/activation/tools.mjs";
import { createState } from "../src/scope/state.mjs";
import {
	createBracketLedger,
	createClockOn,
	forkOf,
	registerFork,
	toolLimitOf,
} from "../src/scope/index.mjs";
import { onToolCall } from "../src/station/gates.mjs";
import { handlePanhandleCall } from "../src/station/panhandle-controls.mjs";
import { decidePanhandle } from "../src/station/domain/panhandle.mjs";
import { executePanhandle } from "../src/station/execute.mjs";

const NOW = 1_700_000_000_000;

function branch(ledger, overrides = {}) {
	const startedAt = NOW;
	const registered = registerFork(
		ledger,
		{
			forkId: "worker",
			ownerId: "root",
			intent: "finish the report",
			depth: 0,
			startedAt,
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
	const persisted = [];
	return {
		state: createState(),
		forkLedgerPort: () => ledger,
		forkOwnerId: () => forkId,
		branchRecord: () => forkOf(ledger, forkId),
		clockPort: () => createClockOn(),
		policy: () => "read-write-subagent",
		persist: () => {
			persisted.push(true);
			return true;
		},
		processControlsForTool: () => {},
		assistantForToolCall: () => null,
		messageForToolCall: () => undefined,
		rememberToolGate: () => {},
		noteError: () => {},
		persisted,
	};
}

function gate(station) {
	return (toolCallId, toolName, input = {}) =>
		onToolCall(station, { toolCallId, toolName, input }, {
			sessionManager: { getBranch: () => [] },
		});
}

function call(id, args) {
	return handlePanhandleCall(station, { id, name: "scope_panhandle", arguments: args });
}

let station = null;

describe("a branch with nothing left can still ask", () => {
	test("the spent tool is refused, the panhandle is not, and the grant reopens the tool", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, {
			budget: { read: 0 },
			startedAt: Date.now(),
		});
		station = stationWith(ledger, "worker");
		const admit = gate(station);

		const refused = admit("read-1", "read");
		expect(refused?.block).toBe(true);
		expect(refused.reason).toContain("read");
		// The refusal itself must name the way out.
		expect(refused.reason).toContain("scope_panhandle");

		// The rescue call is free at the gate: it passes without a charge.
		expect(admit("panhandle-1", "scope_panhandle")).toBeUndefined();

		const granted = call("panhandle-1", {
			tools: { read: 1 },
			because: "one more read closes the report",
		});
		expect(granted.isError).toBeUndefined();
		expect(record.budget.read).toBe(1);
		expect(record.remaining.read).toBe(1);
		expect(granted.content[0].text).toContain("read");
		expect(granted.details.because).toBe("one more read closes the report");

		expect(admit("read-2", "read")).toBeUndefined();
		expect(record.remaining.read).toBe(0);
	});

	test("the grant raises the budget line, not only the balance", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, {
			budget: { read: 0 },
			startedAt: Date.now(),
		});
		station = stationWith(ledger, "worker");

		const granted = call("panhandle-1", {
			tools: { bash: 2 },
			because: "run the failing test",
		});
		expect(granted.isError).toBeUndefined();
		// A tool that was absent from the fork budget starts at zero on both
		// sides; otherwise the budget line would hide the grant.
		expect(record.budget.bash).toBe(2);
		expect(record.remaining.bash).toBe(2);
	});
});

describe("the clock and the tools obey the same grant", () => {
	test("seconds move the deadline and end overtime", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, { startedAt: Date.now() - 120_000 });
		expect(record.deadlineAt).toBeLessThan(Date.now());
		expect(toolLimitOf(record)).toBe(1000);
		expect(record.overtimeAt).not.toBeNull();

		station = stationWith(ledger, "worker");
		const before = record.deadlineAt;
		const granted = call("panhandle-1", {
			seconds: 120,
			because: "the last check needs its full minute",
		});
		expect(granted.isError).toBeUndefined();
		expect(record.deadlineAt).toBe(before + 120_000);
		expect(record.overtimeAt).toBeNull();
		expect(toolLimitOf(record)).toBeGreaterThan(1000);
	});

	test("a scope without a clock is refused seconds, and the record is untouched", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, { startedAt: Date.now() });
		record.deadlineAt = null;
		const beforeBudget = record.timeBudgetMs;
		station = stationWith(ledger, "worker");

		const granted = call("panhandle-1", {
			seconds: 30,
			because: "I lost track of time",
		});
		expect(granted.isError).toBe(true);
		expect(granted.details.code).toBe("PANHANDLE_CLOCK_OFF");
		expect(record.timeBudgetMs).toBe(beforeBudget);
		expect(record.deadlineAt).toBeNull();
		expect(record.panhandles).toBeUndefined();
	});
});

describe("the request has limits and a reason", () => {
	test("the schema keeps the tool in the top-level request", () => {
		const tools = new Map();
		wireTools({ registerTool: (tool) => tools.set(tool.name, tool) }, {});
		const panhandle = tools.get("scope_panhandle");
		expect(panhandle).toBeDefined();
		expect(panhandle.loadMode).toBe("essential");
		expect(panhandle.parameters.required).toContain("because");
		expect(panhandle.parameters.anyOf).toEqual([
			{ required: ["tools"] },
			{ required: ["seconds"] },
		]);
	});

	test("over-cap points, over-cap seconds, and a free tool are refused", () => {
		const ledger = createBracketLedger();
		branch(ledger, { startedAt: Date.now() });
		station = stationWith(ledger, "worker");

		expect(call("g1", { tools: { read: 9 }, because: "more" }).details.code)
			.toBe("PANHANDLE_TOOL_LIMIT");
		expect(call("g2", { seconds: 301, because: "more" }).details.code)
			.toBe("PANHANDLE_SECONDS_LIMIT");
		expect(call("g3", { tools: { pin: 1 }, because: "more" }).details.code)
			.toBe("PANHANDLE_FREE_TOOL");
	});

	test("an empty ask and a missing reason are refused before any mutation", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, { startedAt: Date.now() });
		station = stationWith(ledger, "worker");

		expect(call("g1", { because: "nothing in particular" }).details.code)
			.toBe("PANHANDLE_EMPTY");
		expect(call("g2", { tools: { read: 1 } }).details.code)
			.toBe("PANHANDLE_NO_REASON");
		expect(record.budget.read).toBe(0);
		expect(record.panhandles).toBeUndefined();
	});

	test("a blocked plan and a settled branch cannot panhandle", () => {
		const ledger = createBracketLedger();
		branch(ledger, { blocked: true, budget: { read: 1 }, startedAt: Date.now() });
		station = stationWith(ledger, "worker");
		expect(call("g1", { tools: { read: 1 }, because: "start now" }).details.code)
			.toBe("PANHANDLE_BLOCKED");

		const settled = createBracketLedger();
		const record = branch(settled, { startedAt: Date.now() });
		record.status = "ready";
		station = stationWith(settled, "worker");
		expect(call("g2", { tools: { read: 1 }, because: "one more" }).details.code)
			.toBe("PANHANDLE_CLOSED");
	});

	test("the root has no branch to panhandle for", () => {
		const ledger = createBracketLedger();
		station = stationWith(ledger, null);
		const refused = call("g1", { tools: { read: 1 }, because: "please" });
		expect(refused.isError).toBe(true);
		expect(refused.details.code).toBe("NO_BRANCH_BUDGET");
		expect(refused.content[0].text).toContain("scope_fork");
	});

	test("decidePanhandle refuses without a record or a reason, and accepts otherwise", () => {
		expect(decidePanhandle({ because: "x" }).code).toBe("NO_BRANCH_BUDGET");
		expect(decidePanhandle({ record: { status: "running" } }).code)
			.toBe("PANHANDLE_NO_REASON");
		const ok = decidePanhandle({ record: { status: "running" }, because: " finish " });
		expect(ok).toEqual({ ok: true, reason: "finish" });
	});
});

describe("a retry cannot buy the same reprieve twice", () => {
	test("executePanhandle caches its answer per tool call", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger, {
			budget: { read: 0 },
			startedAt: Date.now(),
		});
		const handled = new Map();
		const station = {
			...stationWith(ledger, "worker"),
			processed: {
				handledFor: (id) => handled.get(id) ?? null,
				setHandled: (id, result) => handled.set(id, result),
				markCall: () => {},
			},
		};
		const first = executePanhandle(station, "panhandle-1", {
			tools: { read: 1 },
			because: "one read",
		});
		expect(first.isError).toBeUndefined();
		expect(record.budget.read).toBe(1);

		const retry = executePanhandle(station, "panhandle-1", {
			tools: { read: 1 },
			because: "one read",
		});
		expect(retry).toBe(first);
		expect(record.budget.read).toBe(1);
		expect(record.panhandles).toHaveLength(1);
		expect(station.persisted.length).toBe(1);
	});
});
