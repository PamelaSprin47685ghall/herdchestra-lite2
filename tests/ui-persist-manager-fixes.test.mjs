// Three residue fixes from the abandoned refactor, each verified alone.
//
// 1. The fission UI must not re-enter its own start transition. A flow start
//    while the aggregate loader is up used to set `working` again, so the host
//    saw a turn begin and paired it with a completion for work still running.
// 2. A state write that was owed and lost must be reportable.
// 3. A flow proxy must be unwrappable to the manager every flow shares.

import { describe, expect, test } from "bun:test";

import { installFissionUI } from "../src/host/fission-ui.mjs";
import { createPersistenceAnchor } from "../src/station/persistence-anchor.mjs";
import { FISSION_MANAGER, sharedManagerOf } from "../src/host/fission-manager.mjs";

function fakeSession(agentId = "owner") {
	const listeners = new Set();
	const session = {
		agent: {
			id: agentId,
			state: { messages: [] },
		},
		sessionManager: null,
		subscribe(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		emit(event) {
			for (const handler of listeners) handler(event);
		},
		getQueuedMessages: () => ({ messages: [] }),
		getAgentId: () => agentId,
	};
	return session;
}

describe("fission UI start guard", () => {
	test("a second agent_start while the loader is up does not re-enter", () => {
		const session = fakeSession();
		const bridge = installFissionUI(session, { hasBatch: () => false });
		const seen = [];
		// The multiplexer publishes through the session's own subscription, so
		// one listener is enough to observe what the UI decided to forward.
		session.subscribe((event) => seen.push(event.type));
		bridge.beginWork();
		bridge.accept("flow-a", { type: "agent_start" });
		bridge.accept("flow-b", { type: "agent_start" });
		// Two flow starts while the owner is working must not announce a second
		// beginning; the aggregate loader already represents the batch.
		expect(seen.filter((type) => type === "agent_start")).toHaveLength(1);
		bridge.endWork({ messages: [] });
	});
});

describe("persistence anchor write result", () => {
	function anchor(manager) {
		return createPersistenceAnchor({
			manager,
			type: "test.state",
			state: () => ({ value: 1 }),
			serialize: (value) => JSON.stringify(value),
			// Nothing changes between calls, so the second write is a no-op.
			plan: (previous, next) =>
				previous === next ? null : { kind: "checkpoint", value: next },
			noteError: () => {},
		});
	}

	test("an anchor without a manager reports the write as lost", () => {
		const created = anchor(null);
		expect(created.persist()).toBe(false);
	});

	test("a manager that cannot append reports the write as lost", () => {
		const created = anchor({ getBranch: () => [] });
		expect(created.persist()).toBe(false);
	});

	test("a write with nothing to record counts as success", () => {
		const entries = [];
		const manager = {
			appendCustomEntry: (type, entry) => {
				entries.push({ type, entry });
				return `e${entries.length}`;
			},
			// The entry just written stays on the live branch, so the anchor is
			// trusted and the second persist() has nothing to plan.
			getBranch: () => entries.map((_, index) => ({ id: `e${index + 1}` })),
		};
		const created = anchor(manager);
		expect(created.persist()).toBe(true);
		expect(created.persist()).toBe(true);
		expect(entries).toHaveLength(1);
	});
});

describe("shared manager unwrapping", () => {
	test("a plain manager is returned as-is", () => {
		const manager = { getLeafId: () => null };
		expect(sharedManagerOf(manager)).toBe(manager);
	});

	test("a flow proxy yields the shared manager beneath it", () => {
		const shared = { getLeafId: () => null };
		const proxy = { [FISSION_MANAGER]: true, shared };
		expect(sharedManagerOf(proxy)).toBe(shared);
	});

	test("a non-object yields null", () => {
		expect(sharedManagerOf(undefined)).toBeNull();
		expect(sharedManagerOf("manager")).toBeNull();
	});
});
