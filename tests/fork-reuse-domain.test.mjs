// Scope id reuse: a second fork under a live name amends that scope.
//
// The station layer is not covered here; these cases pin the pure domain:
// turn arithmetic, requirement queueing, supersede, live lookup and the
// pairing invariants a later generation must not break.

import { describe, expect, test } from "bun:test";

import {
	amendFork,
	assertPairing,
	createBracketLedger,
	liveRecordForScope,
	markReady,
	readyChildren,
	registerFork,
	supersedeFork,
	takeReady,
} from "../src/scope/forkjoin.mjs";
import { grantTurns } from "../src/scope/panhandle.mjs";

const NOW = 1_700_000_000_000;

function open(overrides = {}) {
	const ledger = createBracketLedger();
	const out = registerFork(ledger, {
		forkId: "f1",
		scopeId: "worker",
		ownerId: "root",
		fsm: "first",
		depth: 0,
		budget: { read: 2 },
		time: 60,
		startedAt: NOW,
		...overrides,
	});
	if (!out.ok) throw new Error(out.code);
	return { ledger, record: out.fork };
}

describe("amendFork", () => {
	test("adds budget and seconds to a running branch", () => {
		const { ledger, record } = open();
		const out = amendFork(
			ledger,
			"f1",
			{ budget: { read: 3 }, seconds: 30, fsm: "more" },
			{ now: NOW },
		);
		expect(out.ok).toBe(true);
		expect(record.budget.read).toBe(5);
		expect(record.remaining.read).toBe(5);
		expect(record.requirements).toEqual(["more"]);
		expect(record.status).toBe("running");
	});

	test("keeps a blocked branch blocked and queues the requirement", () => {
		const { ledger, record } = open({ blocked: true });
		const out = amendFork(ledger, "f1", { fsm: "unblock me" }, { now: NOW });
		expect(out.ok).toBe(true);
		expect(record.status).toBe("blocked");
		expect(record.requirements).toEqual(["unblock me"]);
	});

	test("refuses a joined branch", () => {
		const { ledger } = open();
		markReady(ledger, "f1", { record: "done" });
		takeReady(ledger, { ownerId: "root" });
		expect(amendFork(ledger, "f1", { budget: { read: 1 } }).code).toBe(
			"FORK_CLOSED",
		);
	});

	test("amending adds every point the work asks for, with no ceiling", () => {
		const { ledger, record } = open({ budget: { read: 18 } });
		const clockBefore = Number.isFinite(record.timeBudgetMs)
			? record.timeBudgetMs
			: 0;
		const out = amendFork(
			ledger,
			"f1",
			{ budget: { read: 11 }, seconds: 301 },
			{ now: NOW },
		);
		expect(out.ok).toBe(true);
		expect(record.budget.read).toBe(29);
		expect(record.remaining.read).toBe(29);
		expect(record.timeBudgetMs).toBe(clockBefore + 301_000);
		expect(out.added).toEqual({ tools: { read: 11 }, seconds: 301 });
	});
});

describe("supersede and live lookup", () => {
	test("a superseded ready record leaves the queue but stays addressable", () => {
		const { ledger } = open();
		markReady(ledger, "f1", { record: "first" });
		expect(readyChildren(ledger, "root")).toEqual(["f1"]);
		expect(supersedeFork(ledger, "f1", NOW).ok).toBe(true);
		expect(readyChildren(ledger, "root")).toEqual([]);
		expect(takeReady(ledger, { ownerId: "root" }).code).toBe("NO_READY_CHILD");
		expect(assertPairing(ledger).ok).toBe(true);
		expect(liveRecordForScope(ledger, "worker")).toBe(ledger.forks.f1);
	});

	test("the newest generation wins the live lookup", () => {
		const { ledger } = open();
		registerFork(ledger, {
			forkId: "f2",
			scopeId: "worker",
			ownerId: "root",
			fsm: "second",
			depth: 0,
			generation: 2,
			continuesForkId: "f1",
			budget: { read: 1 },
			time: 30,
			startedAt: NOW,
		});
		expect(liveRecordForScope(ledger, "WORKER").forkId).toBe("f2");
	});
});

describe("grantTurns", () => {
	test("refuses free tools and empty grants", () => {
		const { record } = open();
		expect(grantTurns(record, { tools: { scope_fork: 1 } }).code).toBe(
			"GRANT_FREE_TOOL",
		);
		expect(grantTurns(record, {}).code).toBe("GRANT_EMPTY");
	});
});
