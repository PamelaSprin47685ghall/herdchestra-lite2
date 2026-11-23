import { describe, expect, test } from "bun:test";

import {
	FAILED,
	JOINED,
	READY,
	RUNNING,
	abandon,
	adoptFork,
	assertPairing,
	createBracketLedger,
	forkOf,
	markReady,
	registerFork,
	reparentOrphans,
	restoreLedgerChecked,
	reviveBlockedFork,
	serializeLedger,
	supersedeFork,
	takeReady,
	unreceivedChildren,
	validLedger,
} from "../src/scope/forkjoin.mjs";
import {
	adoptLedger,
	createForkRegistry,
	identityOf,
	pulse,
	waitForJoin,
	waitForReady,
} from "../src/scope/fork-registry.mjs";
import { scopeActivity } from "../src/scope/activity.mjs";
import {
	attachBaseForkPorts,
	createForkWiring,
} from "../src/scope/fork-wiring.mjs";
import { joinTicket } from "../src/tools/tickets.mjs";
import {
	handleForkCall,
	handleReturnCall,
} from "../src/station/fork-controls.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { createTestStation, testHostBag } from "./helpers/station-ports.mjs";
import { attachForkPorts } from "./helpers/fork-attach.mjs";

const LEDGER_KEYS = [
	"version",
	"seq",
	"closedSeq",
	"receiveSeq",
	"forks",
	"order",
	"queues",
	"levels",
	"totals",
];

function settleRace(promise, ms = 5) {
	return Promise.race([
		promise.then((value) => ({ state: "settled", value })),
		new Promise((resolve) => setTimeout(() => resolve({ state: "waiting" }), ms)),
	]);
}

async function settledWithin(promise, ms = 150) {
	const out = await settleRace(promise, ms);
	expect(out.state).toBe("settled");
	return out.value;
}

function registerChild(ledger, forkId, ownerId = "root", options = {}) {
	const result = registerFork(ledger, {
		forkId,
		ownerId,
		levelKey: options.levelKey ?? "L0",
		intent: options.intent ?? `task ${forkId}`,
		depth: options.depth ?? (ownerId === "root" ? 0 : 1),
		blocked: options.blocked === true,
	});
	expect(result.ok).toBe(true);
	return result.fork;
}

function makeStation(wiring, options = {}) {
	const sessionId = options.sessionId ?? "session-join-invariants";
	const manager = {
		getBranch: () => [],
		getSessionId: () => sessionId,
		appendCustomEntry: () => {},
	};
	const station = createTestStation(SessionStation, manager, {}, {}, {
		host: () => ({
			...testHostBag,
			fork: { wiring: () => wiring },
		}),
	});
	attachForkPorts(station, wiring, {
		conversationKey: options.conversationKey ?? sessionId,
		identity: options.identity ?? null,
		createSession: options.createSession,
		display: options.display ?? null,
	});
	return station;
}

describe("waitForReady termination and wakeup invariants", () => {
	test("two concurrent waitForReady calls racing for one child both settle: one takes it, the other gets NO_UNRECEIVED_WORK when Busy/Idle drops to zero children", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		adoptLedger(registry, "conv-race", ledger);
		registerChild(ledger, "c1", "root");

		const first = waitForReady(registry, ledger, { ownerId: "root", levelKey: "L0" });
		const second = waitForReady(registry, ledger, { ownerId: "root", levelKey: "L0" });

		// While c1 is RUNNING, Busy/Idle shows the child and both joins stay parked.
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 1, Idle: 1]");
		expect((await settleRace(first, 15)).state).toBe("waiting");
		expect((await settleRace(second, 15)).state).toBe("waiting");

		// Completing the bracket must wake waiters without a manual notifyWaiters call.
		expect(markReady(ledger, "c1", { ok: true, record: "done" }).ok).toBe(true);

		const [r1, r2] = await settledWithin(Promise.all([first, second]));
		const results = [r1, r2];
		const winner = results.find((r) => r.ok === true);
		const loser = results.find((r) => r.ok === false);

		expect(winner?.fork?.forkId).toBe("c1");
		expect(winner?.fork?.status).toBe(JOINED);
		expect(loser?.code).toBe("NO_UNRECEIVED_WORK");
		expect(unreceivedChildren(ledger, "root")).toEqual([]);
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 0, Idle: 1]");
	});

	test("waitForReady returns NO_UNRECEIVED_WORK immediately when no running or ready child exists", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		adoptLedger(registry, "conv-empty", ledger);

		const emptyOut = await settledWithin(
			waitForReady(registry, ledger, { ownerId: "root", levelKey: "L0" }),
		);
		expect(emptyOut.ok).toBe(false);
		expect(emptyOut.code).toBe("NO_UNRECEIVED_WORK");

		// A blocked checkpoint never runs and never appears in Busy/Idle.
		registerChild(ledger, "b1", "root", { blocked: true });
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 0, Idle: 1]");

		const blockedOut = await settledWithin(
			waitForReady(registry, ledger, { ownerId: "root", levelKey: "L0" }),
		);
		expect(blockedOut.ok).toBe(false);
		expect(blockedOut.code).toBe("NO_UNRECEIVED_WORK");
	});

	test("abandoning the last running child wakes parked waitForReady with NO_UNRECEIVED_WORK", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		adoptLedger(registry, "conv-abandon", ledger);
		registerChild(ledger, "c1", "root");

		const pending = waitForReady(registry, ledger, { ownerId: "root", levelKey: "L0" });
		expect((await settleRace(pending, 15)).state).toBe("waiting");

		// abandon alone must wake the parked waiter and remove the child from Busy/Idle.
		expect(abandon(ledger, "c1", "parent cancelled").ok).toBe(true);
		expect(forkOf(ledger, "c1")?.status).toBe(FAILED);
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 0, Idle: 1]");

		const out = await settledWithin(pending);
		expect(out.ok).toBe(false);
		expect(out.code).toBe("NO_UNRECEIVED_WORK");
	});

	test("superseding the last child without a replacement wakes parked waitForReady and leaves no ghost Idle", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		adoptLedger(registry, "conv-supersede", ledger);
		registerChild(ledger, "c1", "root");

		const pending = waitForReady(registry, ledger, { ownerId: "root", levelKey: "L0" });
		expect((await settleRace(pending, 15)).state).toBe("waiting");

		// In one synchronous turn the record becomes READY then superseded with no successor.
		expect(markReady(ledger, "c1", { ok: true, record: "v1" }).ok).toBe(true);
		expect(supersedeFork(ledger, "c1").ok).toBe(true);

		expect(unreceivedChildren(ledger, "root")).toEqual([]);
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 0, Idle: 1]");

		const out = await settledWithin(pending);
		expect(out.ok).toBe(false);
		expect(out.code).toBe("NO_UNRECEIVED_WORK");
	});

	test("reparentOrphans and adoptFork moving the last child away wake the old owner's waitForReady with NO_UNRECEIVED_WORK", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		adoptLedger(registry, "conv-reparent", ledger);

		registerChild(ledger, "p1", "root", { depth: 0 });
		registerChild(ledger, "g1", "p1", { depth: 1 });

		const p1Wait = waitForReady(registry, ledger, { ownerId: "p1", levelKey: "L1" });
		expect((await settleRace(p1Wait, 15)).state).toBe("waiting");

		expect(reparentOrphans(ledger, "p1", "root").ok).toBe(true);
		const reparentOut = await settledWithin(p1Wait);
		expect(reparentOut.ok).toBe(false);
		expect(reparentOut.code).toBe("NO_UNRECEIVED_WORK");
		expect(unreceivedChildren(ledger, "root")).toContain("g1");

		// Root can now receive the reparented grandchild normally.
		expect(markReady(ledger, "g1", { ok: true, record: "grandchild-done" }).ok).toBe(true);
		const rootTaken = takeReady(ledger, { ownerId: "root", levelKey: "L0" });
		expect(rootTaken.ok).toBe(true);
		expect(rootTaken.fork.forkId).toBe("g1");

		// Symmetric check for adoptFork on a second owner.
		registerChild(ledger, "p2", "root", { depth: 0 });
		registerChild(ledger, "g2", "p2", { depth: 1 });
		const p2Wait = waitForReady(registry, ledger, { ownerId: "p2", levelKey: "L1" });
		expect((await settleRace(p2Wait, 15)).state).toBe("waiting");

		expect(adoptFork(ledger, "g2", "root").ok).toBe(true);
		const adoptOut = await settledWithin(p2Wait);
		expect(adoptOut.ok).toBe(false);
		expect(adoptOut.code).toBe("NO_UNRECEIVED_WORK");
		expect(unreceivedChildren(ledger, "root")).toContain("g2");
	});

	test("adoptFork and reparentOrphans never re-queue a superseded READY record", () => {
		const ledger = createBracketLedger();
		registerChild(ledger, "p1", "root", { depth: 0 });
		registerChild(ledger, "g1", "p1", { depth: 1 });
		expect(markReady(ledger, "g1", { ok: true, record: "old" }).ok).toBe(true);
		expect(supersedeFork(ledger, "g1").ok).toBe(true);

		expect(adoptFork(ledger, "g1", "root").ok).toBe(true);
		expect(ledger.queues.root ?? []).not.toContain("g1");
		expect(assertPairing(ledger)).toEqual({ ok: true });

		// Even if a superseded id lingered in a source queue, reparentOrphans drops it.
		registerChild(ledger, "g2", "p1", { depth: 1 });
		expect(markReady(ledger, "g2", { ok: true, record: "old-2" }).ok).toBe(true);
		expect(supersedeFork(ledger, "g2").ok).toBe(true);
		ledger.queues.p1 = ["g2"];

		expect(reparentOrphans(ledger, "p1", "root").ok).toBe(true);
		expect(ledger.queues.root ?? []).not.toContain("g2");
		expect(assertPairing(ledger)).toEqual({ ok: true });
		// Only p1 is still RUNNING; g1 and g2 are superseded and must not count as Idle.
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 1, Idle: 1]");
	});

	test("negative guards: keeps parking while a RUNNING child remains, and returns JOIN_CONTEXT_EXCEEDED when admit rejects READY", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		adoptLedger(registry, "conv-guards", ledger);
		registerChild(ledger, "c1", "root");

		const parked = waitForReady(registry, ledger, {
			ownerId: "root",
			levelKey: "L0",
			admit: () => ({ ok: false, reason: "record exceeds window" }),
		});
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 1, Idle: 1]");
		expect((await settleRace(parked, 5)).state).toBe("waiting");

		expect(markReady(ledger, "c1", { ok: true, record: "huge" }).ok).toBe(true);
		const rejected = await settledWithin(parked);
		expect(rejected.ok).toBe(false);
		expect(rejected.code).toBe("JOIN_CONTEXT_EXCEEDED");
		expect(forkOf(ledger, "c1")?.status).toBe(READY);
	});

	test("queue-corruption safeguard: unqueued READY record with no RUNNING child fails assertPairing and settles waitForReady with LEDGER_PAIRING_BROKEN", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		adoptLedger(registry, "conv-corrupt", ledger);
		registerChild(ledger, "c1", "root");
		expect(markReady(ledger, "c1", { ok: true, record: "lost-from-queue" }).ok).toBe(true);

		// Simulate queue corruption: c1 is READY & !supersededAt, but absent from queues.root.
		ledger.queues.root = [];

		const pairing = assertPairing(ledger);
		expect(pairing.ok).toBe(false);

		const out = await settledWithin(
			waitForReady(registry, ledger, { ownerId: "root", levelKey: "L0" }),
		);
		expect(out.ok).toBe(false);
		expect(out.code).toBe("LEDGER_PAIRING_BROKEN");
	});

	test("child waitForJoin unblocks on takeReady without a manual notifyWaiters call", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		adoptLedger(registry, "conv-child-wait", ledger);
		registerChild(ledger, "c1", "root");

		const childWaiting = waitForJoin(registry, ledger, "c1", {
			outcome: { record: "result", failed: false },
		});
		expect(forkOf(ledger, "c1")?.status).toBe(READY);
		expect((await settleRace(childWaiting, 15)).state).toBe("waiting");

		// Parent takes the record directly without manually calling notifyWaiters.
		const taken = takeReady(ledger, { ownerId: "root", levelKey: "L0" });
		expect(taken.ok).toBe(true);
		expect(taken.fork.status).toBe(JOINED);

		const childOut = await settledWithin(childWaiting);
		expect(childOut.ok).toBe(true);
		expect(childOut.fork.status).toBe(JOINED);
	});
});

describe("joinTicket end-to-end unblocking and handler wakeup", () => {
	test("two concurrent joinTicket calls with one child settle cleanly, restore rootWaits to 0, and match Busy/Idle", async () => {
		const wiring = createForkWiring();
		let rootWaits = 0;
		const display = {
			rootWait: (delta) => {
				rootWaits += delta;
			},
			request: () => {},
		};
		const parent = makeStation(wiring, { sessionId: "e2e-dual-join", display });
		let clockPauseBalance = 0;
		const origPause = parent.pauseBranchClock?.bind(parent);
		const origResume = parent.resumeBranchClock?.bind(parent);
		parent.pauseBranchClock = () => {
			clockPauseBalance += 1;
			return origPause?.();
		};
		parent.resumeBranchClock = () => {
			clockPauseBalance -= 1;
			return origResume?.();
		};
		const ledger = parent.forkLedgerPort();
		registerChild(ledger, "c1", "root");

		const child = makeStation(wiring, {
			sessionId: "e2e-dual-join-child",
			identity: {
				forkId: "c1",
				parentOwnerId: "root",
				ownScopeId: "c1",
				childDepth: 1,
				ledger,
				registry: wiring.registry,
			},
		});

		const j1 = joinTicket(parent, "call-join-1", {}, {});
		const j2 = joinTicket(parent, "call-join-2", {}, {});

		expect(rootWaits).toBe(2);
		expect(clockPauseBalance).toBe(2);
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 1, Idle: 1]");
		expect((await settleRace(j1, 5)).state).toBe("waiting");
		expect((await settleRace(j2, 5)).state).toBe("waiting");

		// Child returns through the synchronous station handler directly (no manual ticket notify).
		const ret = handleReturnCall(child, { id: "call-ret-1", arguments: {} });
		expect(ret.details?.awaitingReceipt).toBe(true);

		const [o1, o2] = await settledWithin(Promise.all([j1, j2]));
		const outs = [o1, o2];
		const joined = outs.find((o) => o?.details?.joined === true);
		const refused = outs.find((o) => o?.isError === true);

		expect(joined?.details?.joined).toBe(true);
		expect(joined?.content?.[0]?.text ?? "").toContain("[Child record — fork scope-1]");
		expect(refused?.details?.code).toBe("NO_UNRECEIVED_WORK");
		expect(rootWaits).toBe(0);
		expect(clockPauseBalance).toBe(0);
		expect(scopeActivity(ledger, "root", true)).toBe("[Busy: 1, Idle: 0]");
	});

	test("a throw inside finalizeJoin does not strand a sibling joinTicket or child waitForJoin", async () => {
		const wiring = createForkWiring();
		let rootWaits = 0;
		const display = {
			rootWait: (delta) => {
				rootWaits += delta;
			},
			request: () => {},
		};
		const parent = makeStation(wiring, { sessionId: "e2e-finalize-throw", display });
		const ledger = parent.forkLedgerPort();
		registerChild(ledger, "c1", "root");

		const originalFinalize = parent.finalizeJoin.bind(parent);
		let boom = true;
		parent.finalizeJoin = (...args) => {
			if (boom) {
				boom = false;
				throw new Error("disk full during finalize");
			}
			return originalFinalize(...args);
		};

		const j1 = joinTicket(parent, "call-join-boom-1", {}, {});
		const j2 = joinTicket(parent, "call-join-boom-2", {}, {});
		expect((await settleRace(j1, 5)).state).toBe("waiting");
		expect((await settleRace(j2, 5)).state).toBe("waiting");

		// Child marks ready and waits on waitForJoin concurrently while parent joins race.
		const childWait = waitForJoin(wiring.registry, ledger, "c1", {
			outcome: { record: "payload", failed: false },
		});

		const [o1, o2, childOut] = await settledWithin(Promise.all([j1, j2, childWait]));
		const codes = [o1?.details?.code, o2?.details?.code].sort();
		expect(codes).toEqual(["JOIN_INTERNAL_ERROR", "NO_UNRECEIVED_WORK"]);
		expect(childOut.ok).toBe(true);
		expect(childOut.fork.status).toBe(JOINED);
		expect(rootWaits).toBe(0);
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 0, Idle: 1]");
	});

	test("a synchronous spawner throw inside handleForkCall wakes a parked joinTicket to receive the failed child", async () => {
		const wiring = createForkWiring();
		const parent = makeStation(wiring, { sessionId: "e2e-spawn-throw" });
		const ledger = parent.forkLedgerPort();
		registerChild(ledger, "c-slow", "root");

		const waitingJoin = joinTicket(parent, "call-join-spawn-fail", {}, {});
		expect((await settleRace(waitingJoin, 5)).state).toBe("waiting");

		parent.childSpawnPort = () => () => {
			throw new Error("spawner crashed synchronously");
		};
		const forked = handleForkCall(parent, {
			id: "call-fork-crash",
			arguments: {
				forks: [
					{
						scopeId: "c-broken",
						fsm: "will fail to spawn",
						blocked: false,
						budget: { read: 1 },
						targets: ["src/a.mjs"],
					},
				],
			},
		});
		expect(forked.details?.failed?.length).toBe(1);
		const failedId = forked.details.failed[0];

		const joined = await settledWithin(waitingJoin);
		expect(joined.details?.joined).toBe(true);
		expect(forkOf(ledger, failedId)?.outcome).toBe("failed");
		expect(joined.content?.[0]?.text ?? "").toContain("spawner crashed synchronously");
	});
});

describe("shared ledger across registries and wiring resilience", () => {
	test("two distinct registries observing the same ledger wake each other on markReady, takeReady, and abandon", async () => {
		const regParent = createForkRegistry();
		const regChild = createForkRegistry();
		const ledger = createBracketLedger();

		registerChild(ledger, "c1", "root");
		const parentWait = waitForReady(regParent, ledger, { ownerId: "root", levelKey: "L0" });
		expect((await settleRace(parentWait, 5)).state).toBe("waiting");

		// Child pulses through a different registry instance pointing to the same ledger.
		pulse(regChild, ledger, "c1", { record: "cross-registry", failed: false });
		const taken = await settledWithin(parentWait);
		expect(taken.ok).toBe(true);
		expect(taken.fork.forkId).toBe("c1");

		// Symmetric: child waits in regChild while parent takes through regParent's ledger.
		registerChild(ledger, "c2", "root");
		const childWait = waitForJoin(regChild, ledger, "c2", {
			outcome: { record: "cross-2", failed: false },
		});
		expect((await settleRace(childWait, 5)).state).toBe("waiting");

		expect(takeReady(ledger, { ownerId: "root", levelKey: "L0" }).ok).toBe(true);
		const childDone = await settledWithin(childWait);
		expect(childDone.ok).toBe(true);
		expect(childDone.fork.status).toBe(JOINED);

		// Cross-registry abandon wakes regParent's waitForReady with NO_UNRECEIVED_WORK.
		registerChild(ledger, "c3", "root");
		const waitAbandon = waitForReady(regParent, ledger, { ownerId: "root", levelKey: "L0" });
		expect((await settleRace(waitAbandon, 5)).state).toBe("waiting");

		expect(abandon(ledger, "c3", "cancelled from sibling registry").ok).toBe(true);
		const abandonOut = await settledWithin(waitAbandon);
		expect(abandonOut.ok).toBe(false);
		expect(abandonOut.code).toBe("NO_UNRECEIVED_WORK");
	});

	test("fork-wiring propagates parent registry on child identity and handles missing wiring/registry without ReferenceError", () => {
		const fallback = attachBaseForkPorts(null, null);
		expect(fallback.ledger).toBeNull();
		expect(fallback.registry).toBeTruthy();

		const stubStation = Object.create(SessionStation.prototype);
		stubStation.state = { autopilot: false, relay: { generation: 0, fullFlow: false } };
		stubStation.manager = null;
		stubStation.persist = () => {};
		const emptyWiringAttached = attachBaseForkPorts(stubStation, {});
		expect(emptyWiringAttached.registry).toBeTruthy();
		expect(emptyWiringAttached.ledger).toBeTruthy();

		const wiringA = createForkWiring();
		const spawnedSpecs = [];
		const parent = makeStation(wiringA, {
			sessionId: "wiring-reg-prop",
			createSession: async (input) => {
				spawnedSpecs.push(input);
				return { ok: false, reason: "TEST_STOP", detail: "stop early" };
			},
		});
		const spawner = parent.childSpawnPort();
		const ledger = parent.forkLedgerPort();
		registerChild(ledger, "c-prop", "root");
		spawner({
			forkId: "c-prop",
			ownScopeId: "c-prop",
			parentOwnerId: "root",
			childDepth: 1,
			intent: "check registry propagation",
			receipt: "hi",
			budget: { read: 1 },
			targets: ["x"],
		});

		const childIdentity = identityOf(wiringA.registry, "c-prop");
		expect(childIdentity?.ledger).toBe(ledger);

		// Even if a child station is attached via a different wiring instance, it must
		// reuse the registry carried by its identity so parent and child share waiters.
		const wiringB = createForkWiring();
		const childStation = Object.create(SessionStation.prototype);
		childStation.state = { autopilot: false, relay: { generation: 0, fullFlow: false } };
		childStation.manager = null;
		childStation.persist = () => {};

		const attached = attachBaseForkPorts(childStation, wiringB, {
			conversationKey: "other-session",
			identity: childIdentity,
		});
		expect(attached.registry).toBe(wiringA.registry);
		expect(childStation.forkWaitPort().registry).toBe(wiringA.registry);
		expect(childStation.forkLedgerPort()).toBe(ledger);
	});
});

describe("activity visibility, serialization hygiene, and reviveBlockedFork", () => {
	test("scopeActivity counts only non-superseded RUNNING/READY children, serialization stays clean, and reviveBlockedFork moves BLOCKED to RUNNING", async () => {
		const registry = createForkRegistry();
		const ledger = createBracketLedger();
		adoptLedger(registry, "conv-hygiene", ledger);

		registerChild(ledger, "c-run", "root");
		registerChild(ledger, "c-sup", "root");
		registerChild(ledger, "c-blk", "root", { blocked: true });
		registerChild(ledger, "c-join", "root");
		registerChild(ledger, "c-fail", "root");

		// Drive each child into its distinct terminal/non-active state.
		expect(markReady(ledger, "c-sup", { ok: true, record: "old" }).ok).toBe(true);
		expect(supersedeFork(ledger, "c-sup").ok).toBe(true);
		expect(markReady(ledger, "c-join", { ok: true, record: "ok" }).ok).toBe(true);
		expect(takeReady(ledger, { ownerId: "root", levelKey: "L0" }).ok).toBe(true);
		expect(abandon(ledger, "c-fail", "cancelled").ok).toBe(true);

		// Exercise waitForReady listener attachment once before serializing.
		const pending = waitForReady(registry, ledger, { ownerId: "root", levelKey: "L0" });
		expect((await settleRace(pending, 5)).state).toBe("waiting");

		expect(unreceivedChildren(ledger, "root")).toEqual(["c-run"]);
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 1, Idle: 1]");

		expect(markReady(ledger, "c-run", { ok: true, record: "done" }).ok).toBe(true);
		const taken = await settledWithin(pending);
		expect(taken.ok).toBe(true);
		expect(taken.fork.forkId).toBe("c-run");

		expect(unreceivedChildren(ledger, "root")).toEqual([]);
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 0, Idle: 1]");

		const serialized = serializeLedger(ledger);
		expect(Object.keys(serialized).sort()).toEqual([...LEDGER_KEYS].sort());
		expect(validLedger(serialized)).toBe(true);
		const restored = restoreLedgerChecked(serialized);
		expect(restored.ok).toBe(true);
		expect(assertPairing(restored.ledger)).toEqual({ ok: true });

		// Reviving a BLOCKED fork transitions it to RUNNING, increments Busy/Idle child count, and preserves pairing.
		const revived = reviveBlockedFork(ledger, "c-blk");
		expect(revived.ok).toBe(true);
		expect(forkOf(ledger, "c-blk")?.status).toBe(RUNNING);
		expect(scopeActivity(ledger, "root", false)).toBe("[Busy: 1, Idle: 1]");
		expect(assertPairing(ledger)).toEqual({ ok: true });
	});
});
