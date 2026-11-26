// The production host bag is the other half of the contract.
//
// `shapeHost` can only normalize what the host actually supplies. The split
// kept the bag green by testing `shapeHost` against the contract, while the
// real `createHostBag` handed over `agentId` (a string) instead of `agent`,
// reimplemented `identityForAgent` over a registry method that did not exist,
// and dropped the process-wide fork wiring. A child station then resolved no
// identity, treated itself as root, and charged every tool against a root that
// owns no turns.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { createHostBag } from "../../host-omp/src/activation/index.mjs";
import { createEngine, ENGINE_ONLY_HOST_KEYS, HOST_CONTRACT } from "../../src/engine.mjs";
import { MAIN_AGENT, READ_WRITE_SUBAGENT } from "../../src/core/policy.mjs";
import {
	chargeBranch,
	createBracketLedger,
	registerFork,
} from "../../src/scope/index.mjs";
import { setIdentity } from "../../src/scope/fork-registry.mjs";
import { SessionStation } from "../../src/station/station.mjs";

const FORK_WIRING_KEY = Symbol.for("herdchestra-lite2.fork-wiring.v1");
const PI = {};

function resetWiringSlot() {
	delete globalThis[FORK_WIRING_KEY];
}

beforeEach(resetWiringSlot);
afterEach(resetWiringSlot);

const REQUIRED = Object.freeze({
	session: [
		"managerOf",
		"conversationKey",
		"branch",
		"agent",
		"canRewindRoot",
		"header",
		"setMessages",
		"appendHistory",
		"abort",
	],
	model: ["of", "thinkingOf", "parseSpec", "capabilities", "query"],
	accounting: ["usage", "pricing"],
	fork: ["wiring", "agentIdOf", "sameManager"],
	report: ["record"],
});

test("the production bag names no key outside the contract", () => {
	const bag = createHostBag(PI);
	for (const group of Object.keys(HOST_CONTRACT)) {
		for (const key of Object.keys(bag[group] ?? {})) {
			expect({ group, key, declared: HOST_CONTRACT[group].includes(key) }).toEqual({
				group,
				key,
				declared: true,
			});
		}
	}
});

test("the production bag supplies every key the engine and stations rely on", () => {
	const bag = createHostBag(PI);
	for (const [group, keys] of Object.entries(REQUIRED)) {
		for (const key of keys) {
			expect({ group, key, kind: typeof bag[group]?.[key] }).toEqual({
				group,
				key,
				kind: group === "accounting" ? "object" : "function",
			});
		}
	}
	// These were the split's dead keys: a string where the core reads an
	// identity object, and a read-only flag no station reads.
	expect(bag.session.agentId).toBeUndefined();
	expect(bag.session.isReadOnly).toBeUndefined();
	// Identity lookup belongs to the core registry. A host copy with a second
	// signature was the bug that made every child an orphan.
	expect(bag.fork.identityForAgent).toBeUndefined();
});

test("session.agent returns the host identity object, not an id", () => {
	const bag = createHostBag(PI);
	const identity = Object.freeze({ kind: "sub", id: "agent-1", depth: 1 });
	expect(bag.session.agent({ agent: identity })).toBe(identity);
	expect(bag.session.agent({})).toBeNull();
});

test("the wiring slot is process-wide and first-wins", () => {
	const first = createHostBag(PI);
	const second = createHostBag(PI);
	expect(first.fork.wiring()).toBeNull();

	const wiring = { id: "w" };
	expect(first.fork.wiring(wiring)).toBe(wiring);
	expect(second.fork.wiring()).toBe(wiring);
	expect(second.fork.wiring({ id: "other" })).toBe(wiring);
});

test("a second engine reuses the first engine's registry, ledger, and waiters", () => {
	const tickets = { steer() {}, prompt() {}, rewindRoot() {} };
	const root = createEngine({ host: createHostBag(PI), tickets, env: {} });
	const child = createEngine({ host: createHostBag(PI), tickets, env: {} });

	expect(child.forkWiring()).toBe(root.forkWiring());
	setIdentity(root.forkWiring().registry, "fork_x", {
		forkId: "fork_x",
		agentId: "agent-1",
	});
	expect(child.forkWiring().identityForAgent("agent-1")?.forkId).toBe("fork_x");
});

test("a bound fork identity classifies the station as a writable subagent", () => {
	const child = {
		forkOwnerId: () => "fork_x",
		agentPolicy: null,
	};
	expect(SessionStation.prototype.policy.call(child, {})).toBe(READ_WRITE_SUBAGENT);

	const root = {
		forkOwnerId: () => null,
		agentPolicy: null,
		sessionView: () => ({ branch: () => [], agent: null }),
	};
	expect(SessionStation.prototype.policy.call(root, {})).toBe(MAIN_AGENT);
});

test("the child's identity spends the child's budget, never the root's", () => {
	const ledger = createBracketLedger();
	expect(
		registerFork(ledger, {
			forkId: "fork_x",
			ownerId: "root",
			levelKey: "root|0|0",
			fsm: "child work",
			depth: 0,
			budget: { read: 2 },
		}).ok,
	).toBe(true);

	const child = chargeBranch({}, ledger, {
		ownerId: "fork_x",
		toolCallId: "call-1",
		toolName: "read",
		beatTools: [],
	});
	expect(child.ok).toBe(true);

	// The root owns no record and therefore no turns: the same call at the
	// root is refused. This is why a lost identity made every child tool fail.
	const root = chargeBranch({}, ledger, {
		ownerId: null,
		toolCallId: "call-2",
		toolName: "read",
		beatTools: [],
	});
	expect(root.ok).toBe(false);
	expect(root.code).toBe("ROOT_HAS_NO_BUDGET");
});
