// A user abort ends the branch, not one turn. These cases pin the cascade at
// its three seams: the ledger close, the host abort hand-off, and the ticket
// that must not start work after its own fork was cancelled.

import { describe, expect, test } from "bun:test";

import {
	abandonDescendants,
	createBracketLedger,
	forkOf,
	markReady,
	registerFork,
	unreceivedChildren,
} from "../src/scope/forkjoin.mjs";
import { createForkRegistry, notifyWaiters } from "../src/scope/fork-registry.mjs";
import {
	attachBaseForkPorts,
	bindHostForkPorts,
	createForkWiring,
} from "../src/scope/fork-wiring.mjs";
import { cancelDescendants, onSessionStop } from "../src/station/gates.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { spawnChildTicket } from "../src/tools/spawn-ticket.mjs";

const REASON = "cancelled by the parent scope";

function fork(ledger, forkId, ownerId) {
	const result = registerFork(ledger, {
		forkId,
		scopeId: forkId,
		ownerId,
		fsm: "one state",
		depth: ownerId === "root" ? 0 : 1,
	});
	expect(result.ok).toBe(true);
	return result.fork;
}

function tree() {
	const ledger = createBracketLedger();
	const registry = createForkRegistry();
	fork(ledger, "child", "root");
	fork(ledger, "grandchild", "child");
	fork(ledger, "ready", "child");
	markReady(ledger, "ready", { record: "done" });
	fork(ledger, "joined", "root");
	forkOf(ledger, "joined").status = "joined";
	return { ledger, registry };
}

function rootStation(ledger, registry, aborts = [], persisted = []) {
	return {
		forkLedgerPort: () => ledger,
		forkWaitPort: () => ({ registry, ledger }),
		forkOwnerId: () => null,
		persistLedger: () => persisted.push("persist"),
		abortChildrenPort: (ids) => {
			for (const id of ids) aborts.push(id);
		},
	};
}

describe("abort cascade", () => {
	test("preserves breadth-first discovery and leaf-first closure across siblings", () => {
		const ledger = createBracketLedger();
		fork(ledger, "a", "root");
		fork(ledger, "b", "root");
		fork(ledger, "a1", "a");
		fork(ledger, "b1", "b");
		fork(ledger, "a2", "a");
		const result = abandonDescendants(ledger, "root", REASON);
		expect(result.abandonedIds).toEqual(["b1", "a2", "a1", "b", "a"]);
		expect(result.runningIds).toEqual(["b1", "a2", "a1", "b", "a"]);
	});

	test("closes every open descendant and reports the running ones", () => {
		const { ledger, registry } = tree();
		const aborts = [];
		const persisted = [];

		const result = cancelDescendants(rootStation(ledger, registry, aborts, persisted));

		expect([...result.abandonedIds].sort()).toEqual(["child", "grandchild", "ready"]);
		expect([...result.runningIds].sort()).toEqual(["child", "grandchild"]);
		expect([...aborts].sort()).toEqual(["child", "grandchild"]);
		expect(persisted).toEqual(["persist"]);
		for (const id of ["child", "grandchild", "ready"]) {
			expect(forkOf(ledger, id).status).toBe("failed");
			expect(forkOf(ledger, id).reason).toBe(REASON);
		}
		// A joined fork is already delivered; the cascade must not reopen it.
		expect(forkOf(ledger, "joined").status).toBe("joined");
		expect(unreceivedChildren(ledger, "root")).toEqual([]);
		expect(unreceivedChildren(ledger, "child")).toEqual([]);
	});

	test("a second abort changes nothing and stops no agent twice", () => {
		const { ledger, registry } = tree();
		const aborts = [];
		const station = rootStation(ledger, registry, aborts);

		cancelDescendants(station);
		const again = cancelDescendants(station);

		expect(again).toEqual({ abandonedIds: [], runningIds: [] });
		expect([...aborts].sort()).toEqual(["child", "grandchild"]);
	});

	test("a parked join wakes when its child is cancelled", () => {
		const { ledger, registry } = tree();
		const woken = [];
		registry.waiters.add({ resolve: () => woken.push("join") });

		cancelDescendants(rootStation(ledger, registry));

		expect(woken).toEqual(["join"]);
		notifyWaiters(registry);
		expect(woken).toEqual(["join"]);
	});

	test("the session-stop gate cancels only on a user abort", () => {
		const { ledger, registry } = tree();
		const station = {
			state: { autopilot: true, relay: { canStop: false, handoffPending: false } },
			relayOn: () => true,
			recordNaturalStop: () => {},
			cancelDescendants: () => cancelDescendants(station),
			...rootStation(ledger, registry),
		};

		onSessionStop(station, {}, { reason: "error" });
		expect(forkOf(ledger, "child").status).toBe("running");

		onSessionStop(station, {}, { reason: "aborted" });
		expect(forkOf(ledger, "child").status).toBe("failed");
	});

	test("a ticket cancelled during session creation never prompts", async () => {
		const ledger = createBracketLedger();
		const registry = createForkRegistry();
		fork(ledger, "child", "root");
		let prompts = 0;
		const registered = [];

		const result = await spawnChildTicket(
			{ forkId: "child", receipt: "work" },
			{
				registry,
				ledger,
				report: () => {},
				persistLedger: () => {},
				registerRunning: (forkId, abort) => registered.push([forkId, abort]),
				unregisterRunning: () => {},
				abortChild: () => {},
				createSession: async () => {
					// The cascade lands while the host is still assembling.
					abandonDescendants(ledger, "root", REASON);
					return { ok: true, session: { prompt: () => { prompts += 1; } } };
				},
			},
		);

		expect(result.ok).toBe(true);
		expect(prompts).toBe(0);
		expect(forkOf(ledger, "child").status).toBe("failed");
		expect(forkOf(ledger, "child").reason).toBe(REASON);
		expect(registered.length).toBe(1);
	});

	// The unit cases above drive a station double. This one drives the real
	// wiring: two stations on one tree ledger, each registering a live child
	// through the ports its own spawner builds. A per-station handle map passes
	// the double and fails here, which is the bug this case exists to catch.
	test("a root cascade stops a child and a grandchild registered through real wiring", async () => {
		const spawns = [];
		const wiring = createForkWiring(
			{},
			{
				spawn: (spec, ports) => {
					spawns.push({ spec, ports });
					return Promise.resolve({ ok: true, failed: false, reason: null });
				},
			},
		);
		const persisted = [];
		const root = Object.create(SessionStation.prototype);
		root.state = { autopilot: false, relay: { generation: 0, fullFlow: false } };
		root.manager = null;
		root.persist = () => {
			persisted.push("root");
		};
		const rootPorts = attachBaseForkPorts(root, wiring, { conversationKey: "tree" });
		bindHostForkPorts(root, wiring, { createSession: async () => ({ ok: false }) });
		const ledger = rootPorts.ledger;
		fork(ledger, "child", "root");
		fork(ledger, "grandchild", "child");

		const child = Object.create(SessionStation.prototype);
		child.state = { autopilot: false, relay: { generation: 0, fullFlow: false } };
		child.manager = null;
		child.persist = () => {};
		attachBaseForkPorts(child, wiring, {
			conversationKey: "child",
			identity: { forkId: "child", ledger },
		});
		bindHostForkPorts(child, wiring, { createSession: async () => ({ ok: false }) });

		const aborts = [];
		root.childSpawnPort()({ forkId: "child", receipt: "work", fsm: "one state" });
		const childPorts = spawns.at(-1).ports;
		child.childSpawnPort()({ forkId: "grandchild", receipt: "work", fsm: "one state" });
		const grandchildPorts = spawns.at(-1).ports;
		childPorts.registerRunning("child", () => aborts.push("child"));
		grandchildPorts.registerRunning("grandchild", () => aborts.push("grandchild"));

		onSessionStop(root, {}, { reason: "aborted" });

		expect([...aborts].sort()).toEqual(["child", "grandchild"]);
		expect(persisted.length).toBe(1);
		expect(forkOf(ledger, "child").status).toBe("failed");
		expect(forkOf(ledger, "grandchild").status).toBe("failed");
		// A second Esc finds no open descendant and stops nobody again.
		onSessionStop(root, {}, { reason: "aborted" });
		expect([...aborts].sort()).toEqual(["child", "grandchild"]);
	});
});
