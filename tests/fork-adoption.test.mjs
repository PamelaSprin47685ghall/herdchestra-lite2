// Adoption: every returned bracket must land on a receiver that can still
// join it. A branch that returned in the same tick, joined earlier, or failed
// can never call scope_join again, so its address is not a receiver.

import { describe, expect, test } from "bun:test";

import {
	adoptFork,
	createBracketLedger,
	liveReceiverOf,
	markReady,
	registerFork,
	rehomeReadyResults,
	reparentOrphans,
	serializeLedger,
	supersedeFork,
	takeReady,
} from "../src/scope/index.mjs";
import { restoreLedgerChecked } from "../src/scope/forkjoin.mjs";
import {
	createForkRegistry,
	notifyWaiters,
	waitForJoin,
} from "../src/scope/fork-registry.mjs";
import { handleReturnCall } from "../src/station/fork-controls.mjs";
import { returnTicket } from "../src/tools/tickets.mjs";

function register(ledger, forkId, ownerId) {
	const result = registerFork(ledger, {
		forkId,
		ownerId,
		levelKey: `${ownerId}|0|0`,
		fsm: `work for ${forkId}`,
		depth: ownerId === "root" ? 0 : 1,
	});
	expect(result.ok).toBe(true);
	return result.fork;
}

function returnStation(ledger, forkId) {
	return {
		state: { amends: [] },
		forkLedgerPort: () => ledger,
		forkIdentityPort: () => ({ forkId }),
		setChildOutcome() {},
		contextMessages: () => [],
		persistLedger: () => true,
		noteError() {},
	};
}

describe("liveReceiverOf", () => {
	test("a running owner receives its children", () => {
		const ledger = createBracketLedger();
		register(ledger, "fork_a", "root");
		expect(liveReceiverOf(ledger, "fork_a")).toBe("fork_a");
		expect(liveReceiverOf(ledger, "root")).toBe("root");
	});

	test("climbs past returned, joined, and failed branches", () => {
		const ledger = createBracketLedger();
		register(ledger, "fork_a", "root");
		register(ledger, "fork_b", "fork_a");
		markReady(ledger, "fork_b", { ok: true });
		expect(takeReady(ledger, { ownerId: "fork_a" }).ok).toBe(true);
		expect(ledger.forks.fork_b.status).toBe("joined");
		expect(ledger.forks.fork_a.status).toBe("running");
		expect(liveReceiverOf(ledger, "fork_b")).toBe("fork_a");

		markReady(ledger, "fork_a", { ok: true });
		expect(liveReceiverOf(ledger, "fork_a")).toBe("root");
		expect(liveReceiverOf(ledger, "fork_b")).toBe("root");
	});

	test("an unknown or cyclic owner falls back to the root", () => {
		const ledger = createBracketLedger();
		register(ledger, "fork_a", "fork_b");
		register(ledger, "fork_b", "fork_a");
		markReady(ledger, "fork_a", { ok: true });
		markReady(ledger, "fork_b", { ok: true });
		expect(liveReceiverOf(ledger, "fork_a")).toBe("root");
		expect(liveReceiverOf(ledger, "missing")).toBe("missing");
	});
});

describe("scope_return after the receiver returned", () => {
	test("the child is re-addressed to the live receiver and can be joined", async () => {
		const ledger = createBracketLedger();
		register(ledger, "fork_a", "root");
		register(ledger, "fork_b", "fork_a");
		// A returned and the root took it before B came back.
		markReady(ledger, "fork_a", { ok: true });
		expect(takeReady(ledger, { ownerId: "root" }).ok).toBe(true);

		const out = handleReturnCall(returnStation(ledger, "fork_b"), {
			id: "call-return-b",
			name: "scope_return",
			arguments: {},
		});

		expect(out.details.awaitingReceipt).toBe(true);
		expect(out.details.receiver).toBe("root");
		expect(ledger.forks.fork_b.ownerId).toBe("root");
		expect(ledger.forks.fork_b.status).toBe("ready");
		expect(ledger.queues.root).toContain("fork_b");

		const registry = createForkRegistry();
		const waited = waitForJoin(registry, ledger, "fork_b");
		const take = takeReady(ledger, { ownerId: "root" });
		expect(take.ok).toBe(true);
		expect(take.fork.forkId).toBe("fork_b");
		notifyWaiters(registry);
		expect((await waited).ok).toBe(true);
	});

	test("orphans follow the resolved receiver, not the dead branch", () => {
		const ledger = createBracketLedger();
		register(ledger, "fork_a", "root");
		register(ledger, "fork_b", "fork_a");
		register(ledger, "fork_c", "fork_b");
		markReady(ledger, "fork_a", { ok: true });

		const moved = reparentOrphans(ledger, "fork_b", "fork_a");
		expect(moved.ok).toBe(true);
		expect(ledger.forks.fork_c.ownerId).toBe("root");
	});

	test("adoptFork moves a ready record and its queue entry together", () => {
		const ledger = createBracketLedger();
		register(ledger, "fork_a", "root");
		register(ledger, "fork_b", "fork_a");
		markReady(ledger, "fork_b", { ok: true });
		expect(ledger.queues.fork_a).toContain("fork_b");

		const adopted = adoptFork(ledger, "fork_b", "root");
		expect(adopted.adopted).toBe(true);
		expect(ledger.forks.fork_b.ownerId).toBe("root");
		expect(ledger.forks.fork_b.reparentedFrom).toBe("fork_a");
		expect(ledger.queues.fork_a ?? []).not.toContain("fork_b");
		expect(ledger.queues.root).toContain("fork_b");
	});
});

describe("a reused scope releases its parked child", () => {
	test("a superseded ready record ends the return wait", async () => {
		const ledger = createBracketLedger();
		register(ledger, "fork_a", "root");
		markReady(ledger, "fork_a", { ok: true });
		expect(supersedeFork(ledger, "fork_a").ok).toBe(true);

		const registry = createForkRegistry();
		const waited = await waitForJoin(registry, ledger, "fork_a");

		expect(waited.ok).toBe(true);
		expect(waited.superseded).toBe(true);
	});

	test("the return ticket closes with an accepted superseded receipt", async () => {
		const ledger = createBracketLedger();
		register(ledger, "fork_a", "root");
		markReady(ledger, "fork_a", { ok: true });
		const registry = createForkRegistry();
		const station = {
			executeReturn: () => ({
				content: [{ type: "text", text: "queued" }],
				details: {
					forkId: "fork_a",
					scopeId: "demo",
					receiver: "root",
					receiverText: "Root",
					awaitingReceipt: true,
				},
			}),
			forkWaitPort: () => ({ registry, ledger }),
			pauseBranchClock() {},
			resumeBranchClock() {},
		};

		const pending = returnTicket(station, "call", {}, {}, null);
		expect(supersedeFork(ledger, "fork_a").ok).toBe(true);
		notifyWaiters(registry);
		const result = await pending;

		expect(result.details.accepted).toBe(true);
		expect(result.details.superseded).toBe(true);
		expect(result.details.awaitingReceipt).toBe(false);
		expect(result.content[0].text).toContain("superseded");
	});
});

describe("restore re-homes results whose receiver is gone", () => {
	test("a ready result under a joined branch is queued for the root", () => {
		const ledger = createBracketLedger();
		register(ledger, "fork_a", "root");
		register(ledger, "fork_b", "fork_a");
		markReady(ledger, "fork_a", { ok: true });
		expect(takeReady(ledger, { ownerId: "root" }).ok).toBe(true);
		markReady(ledger, "fork_b", { ok: true });
		expect(ledger.queues.fork_a).toContain("fork_b");

		const restored = restoreLedgerChecked(serializeLedger(ledger));

		expect(restored.ok).toBe(true);
		expect(restored.ledger.forks.fork_b.ownerId).toBe("root");
		expect(restored.ledger.queues.root).toContain("fork_b");
		const take = takeReady(restored.ledger, { ownerId: "root" });
		expect(take.ok).toBe(true);
		expect(take.fork.forkId).toBe("fork_b");
	});

	test("rehome keeps ready sequence order and is idempotent", () => {
		const ledger = createBracketLedger();
		register(ledger, "fork_a", "root");
		register(ledger, "fork_b", "root");
		markReady(ledger, "fork_b", { ok: true });
		markReady(ledger, "fork_a", { ok: true });

		rehomeReadyResults(ledger);
		rehomeReadyResults(ledger);

		expect(ledger.queues.root).toEqual(["fork_b", "fork_a"]);
		expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("fork_b");
	});
});
