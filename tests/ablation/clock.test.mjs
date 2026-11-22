// Ablation contract: the wall clock is a port over the persisted fork record.
//
// The old shape kept a keyed map inside the feature module; the fork record
// kept a deadline computed inline in `registerFork`. Two owners of one fact.
// The contract is now stateless: the record owns `deadlineAt`, the port owns
// the arithmetic, and `off` means no deadline and no gate.

import { expect, test } from "bun:test";
import { createTestStation } from "../helpers/station-ports.mjs";

import { buildPorts } from "../../src/core/ports/build.mjs";
import { createBracketLedger, registerFork } from "../../src/scope/index.mjs";
import { SessionStation } from "../../src/station/station.mjs";

function record(overrides = {}) {
	return {
		timeBudgetMs: 60_000,
		startedAt: 1_000,
		deadlineAt: null,
		clockPausedAt: null,
		pausedMs: 0,
		overtimeAt: null,
		...overrides,
	};
}

test("clock off is a real ablation: no deadline, no pause, no tool gate", () => {
	const ports = buildPorts({ HERD_CLOCK: "off" });
	expect(ports.ok).toBe(true);
	expect(ports.names.clock).toBe("off");

	const clock = ports.implementations.clock;
	const fork = record();
	clock.start(fork, fork.timeBudgetMs, fork.startedAt);
	expect(fork.deadlineAt).toBeNull();
	expect(clock.info(fork, 31_000)).toEqual({ bounded: false });
	expect(clock.toolLimit(fork, 31_000)).toBeNull();
	expect(clock.pause(fork, 31_000)).toBe(false);
	expect(clock.resume(fork, 31_000)).toBe(false);
});

test("clock on owns the deadline arithmetic", () => {
	const ports = buildPorts({ HERD_CLOCK: "on" });
	expect(ports.ok).toBe(true);
	expect(ports.names.clock).toBe("on");

	const clock = ports.implementations.clock;
	const fork = record();
	clock.start(fork, fork.timeBudgetMs, fork.startedAt);
	expect(fork.deadlineAt).toBe(61_000);
	expect(clock.info(fork, 31_000)).toEqual({
		bounded: true,
		overtime: false,
		leftMs: 30_000,
	});
	expect(clock.toolLimit(fork, 31_000)).toBe(31_000);

	expect(clock.pause(fork, 31_000)).toBe(true);
	expect(clock.info(fork, 41_000)).toEqual({
		bounded: true,
		overtime: false,
		leftMs: 30_000,
	});
	expect(clock.resume(fork, 41_000)).toBe(true);
	expect(fork.deadlineAt).toBe(71_000);
	expect(fork.pausedMs).toBe(10_000);
	expect(fork.clockPausedAt).toBeNull();
});

test("registerFork no longer computes the deadline inline", () => {
	const ledger = createBracketLedger();
	const registered = registerFork(ledger, {
		forkId: "child-1",
		ownerId: "root",
		intent: "hold the wall clock",
		depth: 0,
		time: 60,
		startedAt: 1_000,
	});
	expect(registered.ok).toBe(true);
	expect(registered.fork.timeBudgetMs).toBe(60_000);
	expect(registered.fork.deadlineAt).toBeNull();

	const clock = buildPorts({ HERD_CLOCK: "on" }).implementations.clock;
	clock.start(
		registered.fork,
		registered.fork.timeBudgetMs,
		registered.fork.startedAt,
	);
	expect(registered.fork.deadlineAt).toBe(61_000);
});

test("the station's clock methods ask the injected clock implementation", () => {
	const calls = [];
	const clock = {
		toolLimit() {
			calls.push("toolLimit");
			return 1_234;
		},
		pause() {
			calls.push("pause");
			return true;
		},
		resume() {
			calls.push("resume");
			return true;
		},
	};
	const ledger = createBracketLedger();
	registerFork(ledger, {
		forkId: "child-1",
		ownerId: "root",
		intent: "use the injected clock",
		depth: 0,
	});
	const station = createTestStation(SessionStation, 
		{ getSessionId: () => "s1", getBranch: () => [] },
		{},
		{},
		{ ports: () => ({ clock: "on" }), implementations: () => ({ clock }) },
		null,
	);
	station.forkLedgerPort = () => ledger;
	station.forkOwnerId = () => "child-1";

	expect(station.toolTimeLimit()).toBe(1_234);
	expect(station.pauseBranchClock()).toBe(true);
	expect(station.resumeBranchClock()).toBe(true);
	expect(calls).toEqual(["toolLimit", "pause", "resume"]);
});
