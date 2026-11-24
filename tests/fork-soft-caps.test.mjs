// Soft caps: the runtime never blocks a split or a rescue; it does not stay quiet either.
//
// The consumer is the model that just exceeded a cap: the call lands in full,
// and the receipt says in plain words that the number was over the line and
// must not be repeated. Hard refusals stay for the one case a grant must not
// buy: an unbounded clock.

import { describe, expect, test } from "bun:test";

import { wireTools } from "../src/tools/catalog.mjs";
import { createState } from "../src/scope/state.mjs";
import {
	createBracketLedger,
	forkOf,
	registerFork,
} from "../src/scope/index.mjs";
import {
	PANHANDLE_DEFAULT_POINTS,
	PANHANDLE_MAX_POINTS,
	PANHANDLE_MAX_SECONDS,
	applyPanhandle,
} from "../src/scope/panhandle.mjs";
import {
	FORK_DEFAULT_DEPTH,
	FORK_RECOMMENDED_DEPTH,
	SCOPE_MAX_BUDGET_POINTS,
} from "../src/scope/budget.mjs";
import { validateForkBatch } from "../src/station/domain/fork-join.mjs";
import { childReceiptText, handleForkCall } from "../src/station/fork-controls.mjs";
import { handlePanhandleCall } from "../src/station/panhandle-controls.mjs";

const NOW = 1_700_000_000_000;

function warnings(text) {
	return (text.match(/WARNING/g) ?? []).length;
}

function forkStation(ledger) {
	const spawned = [];
	const station = {
		state: { scopes: [], autopilot: false, relay: { generation: 0, fullFlow: false } },
		forkLedgerPort: () => ledger,
		childSpawnPort: () => (spec) => {
			spawned.push(spec);
		},
		persist: () => true,
		now: () => NOW,
		spawned,
	};
	return station;
}

function forkItem(scopeId, overrides = {}) {
	return {
		scopeId,
		fsm: `work on ${scopeId}`,
		blocked: false,
		budget: { read: 6 },
		targets: [`src/${scopeId}.mjs`],
		...overrides,
	};
}

function panhandleAt(ledger, forkId) {
	const station = {
		state: createState(),
		forkLedgerPort: () => ledger,
		forkOwnerId: () => forkId,
		branchRecord: () => forkOf(ledger, forkId),
		clockPort: () => ({ now: () => NOW }),
		policy: () => "read-write-subagent",
		persist: () => true,
		processControlsForTool: () => {},
		assistantForToolCall: () => null,
		messageForToolCall: () => undefined,
		rememberToolGate: () => {},
		noteError: () => {},
	};
	return (id, args) =>
		handlePanhandleCall(station, { id, name: "scope_panhandle", arguments: args });
}

function branch(ledger, overrides = {}) {
	const out = registerFork(
		ledger,
		{
			forkId: "worker",
			scopeId: "worker",
			ownerId: "root",
			fsm: "finish the report",
			depth: 0,
			startedAt: NOW,
			budget: { read: 0 },
			time: 60,
			...overrides,
		},
		{ clock: { now: () => NOW } },
	);
	if (!out.ok) throw new Error(out.code);
	return out.fork;
}

describe("one fork call may hold more children than the cap", () => {
	test("a fan-out of 6 passes without a warning", () => {
		const ledger = createBracketLedger();
		const station = forkStation(ledger);
		const result = handleForkCall(station, {
			id: "call-6",
			arguments: {
				forks: Array.from({ length: 6 }, (_, i) => forkItem(`s${i}`)),
			},
		});
		expect(result.isError).toBeUndefined();
		expect(warnings(result.content[0].text)).toBe(0);
		expect(station.spawned).toHaveLength(6);
	});

	test("a fan-out of 7 with ready and blocked items starts them all and warns", () => {
		const ledger = createBracketLedger();
		const station = forkStation(ledger);
		const forks = Array.from({ length: 6 }, (_, i) => forkItem(`s${i}`));
		forks.push(forkItem("s6", { blocked: true, budget: { read: 1 } }));
		const result = handleForkCall(station, {
			id: "call-7",
			arguments: { forks },
		});
		expect(result.isError).toBeUndefined();
		const text = result.content[0].text;
		expect(warnings(text)).toBe(1);
		expect(text).toContain("7");
		expect(text).toContain("6");
		expect(text).toMatch(/do not repeat/i);
		expect(ledger.order).toHaveLength(7);
	});
});

describe("one scope may hold more points than the cap", () => {
	test("a scope of 27 points passes without a warning", () => {
		const ledger = createBracketLedger();
		const station = forkStation(ledger);
		const result = handleForkCall(station, {
			id: "call-27",
			arguments: {
				forks: [forkItem("wide", { budget: { read: 14, edit: 13 } })],
			},
		});
		expect(result.isError).toBeUndefined();
		expect(warnings(result.content[0].text)).toBe(0);
		expect(forkOf(ledger, ledger.order[0]).budget.read).toBe(14);
	});

	test("a scope of 28 points starts anyway and names itself in the warning", () => {
		const ledger = createBracketLedger();
		const station = forkStation(ledger);
		const result = handleForkCall(station, {
			id: "call-28",
			arguments: {
				forks: [forkItem("over", { budget: { read: 15, edit: 13 } })],
			},
		});
		expect(result.isError).toBeUndefined();
		const text = result.content[0].text;
		expect(warnings(text)).toBe(1);
		expect(text).toContain("over");
		expect(text).toContain("28");
		expect(text).toContain("27");
		expect(forkOf(ledger, ledger.order[0]).budget.read).toBe(15);
	});
});

describe("adding points to a live scope is a soft cap too", () => {
	test("18 plus 9 stays quiet, a further point warns, and a bare intent does not repeat it", () => {
		const ledger = createBracketLedger();
		const station = forkStation(ledger);
		handleForkCall(station, {
			id: "call-open",
			arguments: { forks: [forkItem("grow", { budget: { read: 9, edit: 9 } })] },
		});
		const forkId = ledger.order[0];

		const toCap = handleForkCall(station, {
			id: "call-cap",
			arguments: {
				forks: [{ scopeId: "grow", blocked: false, budget: { read: 9 }, targets: ["grow.mjs"] }],
			},
		});
		expect(toCap.isError).toBeUndefined();
		expect(warnings(toCap.content[0].text)).toBe(0);
		expect(forkOf(ledger, forkId).budget.read).toBe(18);

		const toOver = handleForkCall(station, {
			id: "call-over",
			arguments: {
				forks: [{ scopeId: "grow", blocked: false, budget: { edit: 1 }, targets: ["grow.mjs"] }],
			},
		});
		expect(toOver.isError).toBeUndefined();
		expect(forkOf(ledger, forkId).budget.edit).toBe(10);
		expect(warnings(toOver.content[0].text)).toBe(1);

		const intentOnly = handleForkCall(station, {
			id: "call-note",
			arguments: {
				forks: [forkItem("grow", { fsm: "one more slice", budget: {} })],
			},
		});
		expect(intentOnly.isError).toBeUndefined();
		expect(warnings(intentOnly.content[0].text)).toBe(0);
		expect(forkOf(ledger, forkId).requirements).toEqual(["one more slice"]);
	});

	test("the domain reports both overages for one batch", () => {
		const batch = validateForkBatch({
			forks: [
				forkItem("over", { budget: { read: 15, edit: 13 } }),
				...Array.from({ length: 6 }, (_, i) => forkItem(`f${i}`, { budget: { read: 1 } })),
			],
		});
		expect(batch.ok).toBe(true);
		const codes = (batch.warnings ?? []).map((w) => w.code).sort();
		expect(codes).toContain("SCOPE_OVER_BUDGET_CAP");
		expect(codes).toContain("FANOUT_OVER_CAP");
	});

	test("a batch that breaks both caps warns twice in one receipt", () => {
		const ledger = createBracketLedger();
		const station = forkStation(ledger);
		const forks = [
			forkItem("over", { budget: { read: 15, edit: 13 } }),
			...Array.from({ length: 6 }, (_, i) => forkItem(`f${i}`, { budget: { read: 1 } })),
		];
		const result = handleForkCall(station, { id: "call-both", arguments: { forks } });
		expect(result.isError).toBeUndefined();
		expect(warnings(result.content[0].text)).toBe(2);
		expect(ledger.order).toHaveLength(7);
	});
});

describe("a panhandle is metered over the whole request", () => {
	test("nine points in two tools pass without a warning", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger);
		const call = panhandleAt(ledger, "worker");
		const out = call("p9", { tools: { read: 5, edit: 4 }, because: "five reads and four writes" });
		expect(out.isError).toBeUndefined();
		expect(warnings(out.content[0].text)).toBe(0);
		expect(record.budget).toEqual({ read: 5, edit: 4 });
	});

	test("ten points across tools are granted and the receipt says so", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger);
		const call = panhandleAt(ledger, "worker");
		const out = call("p10", { tools: { read: 5, edit: 5 }, because: "five and five" });
		expect(out.isError).toBeUndefined();
		expect(warnings(out.content[0].text)).toBe(1);
		expect(out.content[0].text).toContain("10");
		expect(out.content[0].text).toContain("9");
		expect(out.content[0].text).toContain("scope_fork");
		expect(record.budget).toEqual({ read: 5, edit: 5 });
		expect(record.remaining).toEqual({ read: 5, edit: 5 });
	});

	test("ten points in one tool are granted like any other overage", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger);
		const call = panhandleAt(ledger, "worker");
		const out = call("p1", { tools: { read: 10 }, because: "ten reads" });
		expect(out.isError).toBeUndefined();
		expect(warnings(out.content[0].text)).toBe(1);
		expect(record.budget.read).toBe(10);
		expect(out.details.overLimit).toBe(true);
		expect(out.details.pointsRequested).toBe(10);
	});

	test("the total is what the domain measures, not each tool", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger);
		const atCap = applyPanhandle(
			ledger,
			"worker",
			{ tools: { read: 6, edit: 3 } },
			{ now: NOW },
		);
		expect(atCap.ok).toBe(true);
		expect(atCap.overLimit).toBe(false);
		expect(atCap.pointsRequested).toBe(PANHANDLE_MAX_POINTS);
		expect(record.budget).toEqual({ read: 6, edit: 3 });

		const overCap = applyPanhandle(
			ledger,
			"worker",
			{ tools: { read: 5, edit: 5 } },
			{ now: NOW },
		);
		expect(overCap.ok).toBe(true);
		expect(overCap.overLimit).toBe(true);
		expect(overCap.pointsRequested).toBe(10);
		expect(record.budget).toEqual({ read: 11, edit: 8 });
	});

	test("a clock above the seconds cap is still refused outright", () => {
		const ledger = createBracketLedger();
		const record = branch(ledger);
		const call = panhandleAt(ledger, "worker");
		const out = call("ps", {
			seconds: PANHANDLE_MAX_SECONDS + 1,
			because: "a whole afternoon",
		});
		expect(out.isError).toBe(true);
		expect(out.details.code).toBe("PANHANDLE_SECONDS_LIMIT");
		expect(record.timeBudgetMs).toBe(60_000);
	});

	test("the schema carries no per-tool maximum, so the cap can only be soft", () => {
		const tools = new Map();
		wireTools({ registerTool: (tool) => tools.set(tool.name, tool) }, {});
		const parameters = tools.get("scope_panhandle").parameters;
		expect(
			parameters.properties.tools.additionalProperties.maximum,
		).toBeUndefined();
		expect(parameters.properties.tools.additionalProperties.minimum).toBe(1);
	});
});

describe("a call under the defaults is ordinary", () => {
	test("an empty budget, one child, and one point all pass clean", () => {
		const ledger = createBracketLedger();
		const station = forkStation(ledger);
		const empty = handleForkCall(station, {
			id: "call-empty",
			arguments: { forks: [forkItem("lean", { budget: {} })] },
		});
		expect(empty.isError).toBeUndefined();
		expect(warnings(empty.content[0].text)).toBe(0);

		const one = handleForkCall(station, {
			id: "call-one",
			arguments: { forks: [forkItem("solo", { budget: { read: 1 } })] },
		});
		expect(warnings(one.content[0].text)).toBe(0);
		expect(station.spawned).toHaveLength(2);

		const panLedger = createBracketLedger();
		branch(panLedger);
		const call = panhandleAt(panLedger, "worker");
		const out = call("p1", { tools: { read: 1 }, because: "one read" });
		expect(out.isError).toBeUndefined();
		expect(warnings(out.content[0].text)).toBe(0);
	});

	test("the defaults and the caps are the numbers the prompt promises", () => {
		expect(PANHANDLE_DEFAULT_POINTS).toBe(6);
		expect(PANHANDLE_MAX_POINTS).toBe(9);
		expect(SCOPE_MAX_BUDGET_POINTS).toBe(27);
	});
});

describe("recommended tree depth guidance", () => {
	function forkStationAt(ledger, depth) {
		const station = forkStation(ledger);
		station.forkDepthPort = () => depth;
		return station;
	}

	test("two layers is the default and three is where it stops being ordinary", () => {
		expect(FORK_DEFAULT_DEPTH).toBe(2);
		expect(FORK_RECOMMENDED_DEPTH).toBe(3);
	});

	test("a child is born knowing its depth and the recommendation, never a maximum", () => {
		const text = childReceiptText({
			forkId: "w1",
			childDepth: 1,
			fsm: "leaf work",
			budget: "read 6",
			targets: ["a.mjs"],
		});
		const firstLine = text.split("\n")[0];
		expect(firstLine.startsWith("You are now in the scope w1,")).toBe(true);
		expect(firstLine).toContain("depth 1");
		expect(firstLine).toContain("2");
		expect(firstLine).toContain("3");
		expect(firstLine).toMatch(/recommended/i);
		expect(text).not.toMatch(/\bmax\b|\bmaximum\b|\bceiling\b/i);
	});

	test("a child born at the recommended depth carries no note", () => {
		const ledger = createBracketLedger();
		const station = forkStationAt(ledger, 2);
		const result = handleForkCall(station, {
			id: "call-depth3",
			arguments: { forks: [forkItem("leaf")] },
		});
		expect(result.isError).toBeUndefined();
		const text = result.content[0].text;
		expect(text).not.toContain("depth 4");
		expect(text).not.toContain("Note —");
		expect(station.spawned).toHaveLength(1);
	});

	test("a fourth layer is born anyway, with a calm note instead of a warning", () => {
		const ledger = createBracketLedger();
		const station = forkStationAt(ledger, 3);
		const result = handleForkCall(station, {
			id: "call-depth4",
			arguments: { forks: [forkItem("deep")] },
		});
		expect(result.isError).toBeUndefined();
		const text = result.content[0].text;
		expect(station.spawned).toHaveLength(1);
		expect(ledger.order).toHaveLength(1);
		expect(text).toContain("depth 4");
		expect(text).toContain("2");
		expect(text).toContain("3");
		expect(text).toMatch(/recommended/i);
		expect(text).toMatch(/explain|justify/i);
		expect(text).toMatch(/compress|prose|relay/i);
		expect(text).not.toContain("WARNING");
		expect(text).not.toMatch(/do not repeat/i);
		expect(text).not.toMatch(/\bmax\b|\bmaximum\b/i);
	});

	test("amending a live fourth-layer scope does not repeat the note", () => {
		const ledger = createBracketLedger();
		const station = forkStationAt(ledger, 3);
		const born = handleForkCall(station, {
			id: "call-born",
			arguments: { forks: [forkItem("deep")] },
		});
		expect(warnings(born.content[0].text)).toBe(0);
		const forkId = ledger.order[0];

		const amended = handleForkCall(station, {
			id: "call-grow",
			arguments: {
				forks: [
					{
						scopeId: "deep",
						blocked: false,
						budget: { read: 1 },
						targets: ["deep.mjs"],
					},
				],
			},
		});
		expect(amended.isError).toBeUndefined();
		const text = amended.content[0].text;
		expect(forkOf(ledger, forkId).budget.read).toBe(7);
		expect(text).not.toContain("Note —");
		expect(text).not.toMatch(/explain|justify/i);
		expect(warnings(text)).toBe(0);
	});
});
