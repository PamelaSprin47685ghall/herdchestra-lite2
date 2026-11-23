// A forked branch carries the wall clock its fork item declared. The station
// must hand that clock to the tool admission gate; without it, `time` is only
// prose in the child's receipt.

import { describe, expect, test } from "bun:test";
import { createTestStation } from "./helpers/station-ports.mjs";

import { installToolDispatch } from "../host-omp/src/host/tool-dispatch.mjs";
import { createForkRegistry, notifyWaiters } from "../src/scope/fork-registry.mjs";
import { joinTicket, returnTicket } from "../src/tools/tickets.mjs";
import {
	createBracketLedger,
	createClockOn,
	markReady,
	pauseClock,
	registerFork,
	resumeClock,
	takeReady,
} from "../src/scope/index.mjs";
import { SessionStation } from "../src/station/station.mjs";

function manager() {
	return {
		getSessionId: () => "session-1",
		getBranch: () => [],
		buildSessionContext: () => ({ messages: [] }),
		appendCustomEntry: () => "entry-1",
	};
}

function ledgerWith(time, startedAt) {
	const ledger = createBracketLedger();
	const registered = registerFork(ledger, {
		forkId: "child-1",
		ownerId: "root",
		levelKey: "root|0|0",
		knuth_nfa_inspired_fsm: "hold the wall clock",
		depth: 0,
		time,
		startedAt,
	}, { clock: createClockOn() });
	if (!registered.ok) throw new Error(registered.reason);
	return { ledger, record: registered.fork };
}

function stationFor(ledger, ownerId) {
	const station = createTestStation(SessionStation, manager(), {}, {}, null, null);
	station.forkLedgerPort = () => ledger;
	station.forkOwnerId = () => ownerId;
	return station;
}

const MESSAGE = { role: "assistant", content: [] };

describe("fork branch wall clock", () => {
	test("the root branch has no clock and is never gated", () => {
		const { ledger } = ledgerWith(60, Date.now());
		const station = stationFor(ledger, null);
		expect(station.toolTimeLimit()).toBeNull();
		expect(station.prepareToolDispatch(MESSAGE, "call-1", "read")).toBe(false);
	});

	test("a child with a time budget is gated for its remaining time plus one second", () => {
		const startedAt = Date.now();
		const { ledger } = ledgerWith(60, startedAt);
		const station = stationFor(ledger, "child-1");
		expect(station.prepareToolDispatch(MESSAGE, "call-1", "read")).toBe(true);
		const limit = station.toolTimeLimit();
		expect(limit).toBeGreaterThan(59_000);
		expect(limit).toBeLessThanOrEqual(61_000);
	});

	test("a child without a time budget has no clock", () => {
		const { ledger } = ledgerWith(undefined, undefined);
		const station = stationFor(ledger, "child-1");
		expect(station.toolTimeLimit()).toBeNull();
		expect(station.prepareToolDispatch(MESSAGE, "call-1", "read")).toBe(false);
	});

	test("an expired clock drops to the one-second chess-clock unit and records overtime", () => {
		const { ledger, record } = ledgerWith(60, Date.now());
		const station = stationFor(ledger, "child-1");
		record.deadlineAt = Date.now() - 1_000;
		expect(station.toolTimeLimit()).toBe(1_000);
		expect(Number.isFinite(record.overtimeAt)).toBe(true);
	});

	test("a tool that overruns its limit is refused after it returns", () => {
		const { ledger } = ledgerWith(60, Date.now());
		const station = stationFor(ledger, "child-1");
		const verdict = station.admitToolDispatch("call-1", "read", {}, {
			elapsedMs: 2_000,
			limitMs: 1_000,
		});
		expect(verdict?.block).toBe(true);
		expect(typeof verdict.reason).toBe("string");
		expect(verdict.reason.length).toBeGreaterThan(0);
	});

	test("a receipt without an admission is refused, not free", () => {
		const { ledger } = ledgerWith(60, Date.now());
		const station = stationFor(ledger, "child-1");
		// A host may call only the post-execution seam. The result must not be
		// free merely because the pre-execution gate never ran.
		const verdict = station.admitToolDispatch("call-receipt", "read", {}, {
			elapsedMs: 0,
			limitMs: 1_000,
		});
		expect(verdict?.block).toBe(true);
		expect(typeof verdict.reason).toBe("string");
		expect(Object.hasOwn(station.state.charges, "call-receipt")).toBe(false);
	});

	test("scope_join and scope_return are never time-gated, even past the deadline", () => {
		const { ledger, record } = ledgerWith(1, Date.now() - 5_000);
		const station = stationFor(ledger, "child-1");
		for (const name of ["scope_join", "scope_return"]) {
			expect(station.prepareToolDispatch(MESSAGE, `call-${name}`, name)).toBe(false);
			expect(station.admitToolDispatch(`call-${name}`, name, {}, null)).toBeUndefined();
		}
		// A normal tool still sees the expired clock.
		expect(station.prepareToolDispatch(MESSAGE, "call-read", "read")).toBe(true);
		expect(record.overtimeAt).not.toBeNull();
	});

	test("the station pauses its branch clock and shifts the deadline on resume", async () => {
		const startedAt = Date.now();
		const { ledger, record } = ledgerWith(60, startedAt);
		const station = stationFor(ledger, "child-1");
		const before = record.deadlineAt;

		expect(station.pauseBranchClock()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(record.deadlineAt).toBe(before);
		expect(station.resumeBranchClock()).toBe(true);
		expect(record.deadlineAt).toBeGreaterThanOrEqual(before + 20);
		expect(record.clockPausedAt).toBeNull();
		// The root owns no record, so it has nothing to pause.
		const root = stationFor(ledger, null);
		expect(root.pauseBranchClock()).toBe(false);
		expect(root.resumeBranchClock()).toBe(false);
	});
});

describe("waiting on the other bracket does not spend the clock", () => {
	test("scope_join pauses the parent clock until the child is taken", async () => {
		const registry = createForkRegistry();
		const { ledger, record } = ledgerWith(60, Date.now());
		const before = record.deadlineAt;
		const station = {
			state: {},
			executeJoin: () => ({
				content: [],
				details: { code: "NO_READY_CHILD", active: 1 },
			}),
			finalizeJoin: () => ({
				content: [{ type: "text", text: "joined" }],
				details: { joined: true },
			}),
			forkWaitPort: () => ({ registry, ledger }),
			forkOwnerId: () => null,
			pauseBranchClock: () => pauseClock(record),
			resumeBranchClock: () => resumeClock(record),
		};

		const pending = joinTicket(station, "join-1", {}, {});
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(Number.isFinite(record.clockPausedAt)).toBe(true);
		expect(record.deadlineAt).toBe(before);
		expect(markReady(ledger, "child-1", { ok: true }).ok).toBe(true);
		notifyWaiters(registry);

		const result = await pending;
		expect(result.details.joined).toBe(true);
		expect(record.clockPausedAt).toBeNull();
		expect(record.deadlineAt).toBeGreaterThanOrEqual(before + 20);
	});

	test("scope_return pauses the child clock while the parent has not taken it", async () => {
		const registry = createForkRegistry();
		const { ledger, record } = ledgerWith(60, Date.now());
		const before = record.deadlineAt;
		const station = {
			state: {},
			forkIdentityPort: () => ({ forkId: "child-1" }),
			forkOwnerId: () => "child-1",
			executeReturn: () => ({
				content: [],
				details: {
					awaitingReceipt: true,
					forkId: "child-1",
					receiver: "root",
					receiverText: "the parent",
				},
			}),
			forkWaitPort: () => ({ registry, ledger }),
			pauseBranchClock: () => pauseClock(record),
			resumeBranchClock: () => resumeClock(record),
		};

		const pending = returnTicket(station, "return-1", {}, {});
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(Number.isFinite(record.clockPausedAt)).toBe(true);
		expect(record.deadlineAt).toBe(before);
		expect(takeReady(ledger, { ownerId: "root" }).ok).toBe(true);
		notifyWaiters(registry);

		const result = await pending;
		expect(result.details.accepted).toBe(true);
		expect(record.clockPausedAt).toBeNull();
		expect(record.deadlineAt).toBeGreaterThanOrEqual(before + 20);
	});
});

function fakeSession(agentId) {
	const agent = {
		id: agentId,
		beforeToolCall(input) {
			return input;
		},
	};
	return { agent, sessionManager: { getSessionId: () => "session-1" } };
}

describe("a receipt after a gate-cache miss still admits the executed call", () => {
	// The post-execution seam re-admits when the bounded gate cache no longer
	// holds the call. That re-admission must not refuse work that already ran,
	// and must not charge it twice: `state.charges` is the idempotence record.
	function fundedStation(budget) {
		const ledger = createBracketLedger();
		const registered = registerFork(
			ledger,
			{
				forkId: "child-1",
				ownerId: "root",
				levelKey: "root|0|0",
				knuth_nfa_inspired_fsm: "pay for its own tools",
				depth: 0,
				time: 60,
				startedAt: Date.now(),
				budget,
			},
			{ clock: createClockOn() },
		);
		if (!registered.ok) throw new Error(registered.reason);
		return { record: registered.fork, station: stationFor(ledger, "child-1") };
	}

	function messageWith(id, path) {
		return {
			role: "assistant",
			content: [
				{ type: "toolCall", id, name: "read", arguments: { path } },
			],
		};
	}

	function evictGate(station) {
		// GATE_LIMIT is 512; 600 unrelated admissions push out every earlier id.
		for (let index = 0; index < 600; index += 1) {
			station.rememberToolGate(`unrelated-${index}`, undefined);
		}
	}

	test("an evicted verdict neither blocks the call nor charges it again", () => {
		const { record, station } = fundedStation({ read: 4 });
		const message = messageWith("call-1", "src/one.mjs");
		expect(station.prepareToolDispatch(message, "call-1", "read")).toBe(true);
		const admitted = station.admitToolDispatch("call-1", "read", {});
		expect(admitted?.limitMs).toBeGreaterThan(0);
		expect(record.spent.read).toBe(1);
		expect(record.remaining.read).toBe(3);

		evictGate(station);
		expect(station.toolGateVerdict("call-1").hit).toBe(false);

		const verdict = station.admitToolDispatch("call-1", "read", {}, {
			elapsedMs: 5,
			limitMs: 1_000,
		});
		expect(verdict).toBeUndefined();
		expect(record.spent.read).toBe(1);
		expect(record.remaining.read).toBe(3);
	});

	test("a free skill read survives the re-admission without becoming billable", () => {
		const { record, station } = fundedStation({ read: 1 });
		const message = messageWith("call-2", "skill://constitution");
		expect(station.prepareToolDispatch(message, "call-2", "read")).toBe(true);
		expect(station.admitToolDispatch("call-2", "read", {})?.limitMs).toBeGreaterThan(0);
		expect(Object.hasOwn(station.state.charges, "call-2")).toBe(false);

		evictGate(station);

		// The arguments are reconstructed from the carrying message, so the
		// skill read keeps its free verdict instead of consuming the branch.
		const verdict = station.admitToolDispatch("call-2", "read", {}, {
			elapsedMs: 5,
			limitMs: 1_000,
		});
		expect(verdict).toBeUndefined();
		expect(record.spent.read).toBe(0);
		expect(record.remaining.read).toBe(1);
	});
});

describe("installToolDispatch", () => {
	test("a gated branch wraps the tool and enforces the limit", async () => {
		const session = fakeSession("child-agent");
		installToolDispatch(
			session,
			() => true,
			(_id, _name, _ctx, receipt) => {
				if (!receipt) return { limitMs: 10 };
				return receipt.elapsedMs > receipt.limitMs
					? { block: true, reason: "overtime" }
					: undefined;
			},
		);
		const tool = {
			name: "read",
			async execute() {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return "done";
			},
		};
		session.agent.beforeToolCall(
			{ assistantMessage: MESSAGE, toolCall: { id: "call-1" }, tool },
			null,
		);
		await expect(
			tool.execute("call-1", {}, null, null, { agent: { id: "child-agent" } }),
		).rejects.toThrow("overtime");
	});

	test("a branch without a clock keeps the original execute untouched", () => {
		const session = fakeSession("root-agent");
		installToolDispatch(session, () => false, () => undefined);
		const tool = { name: "read", execute: async () => "done" };
		const original = tool.execute;
		session.agent.beforeToolCall(
			{ assistantMessage: MESSAGE, toolCall: { id: "call-1" }, tool },
			null,
		);
		expect(tool.execute).toBe(original);
	});
});
