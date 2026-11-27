// Contracts that make the three fork/join tools real: projection, adoption,
// child freeze and report discipline. Each case builds a station through the
// same ports the host wiring injects, never through a private field.

import { describe, expect, test } from "bun:test";

import { SessionStation } from "../src/station/station.mjs";
import { bindStationPorts } from "./helpers/station-ports.mjs";
import { handleJoinCall, handleReturnCall } from "../src/station/fork-controls.mjs";
import { RETURN_OATH_KEY, RETURN_OATH_VALUE } from "../src/station/domain/handoff.mjs";

const OATH = { [RETURN_OATH_KEY]: RETURN_OATH_VALUE };
import { createBracketLedger, markReady, registerFork, takeReady } from "../src/scope/ledger-brackets.mjs";
import { forkOf } from "../src/scope/ledger-charge.mjs";
import { createState } from "../src/scope/state.mjs";
import { createEmptyCatalog } from "../host-omp/src/host/pricing.mjs";
import { createToolCallLedger } from "../src/station/domain/tool-call-ledger.mjs";

/** A root station with only the ports the control handlers read. */
function rootStation(ledger, state = createState()) {
	const station = Object.create(SessionStation.prototype);
	station.state = state;
	station.manager = null;
	station.pricingCatalog = createEmptyCatalog();
	station.ports = bindStationPorts(state);
	station.toolCallLedger = createToolCallLedger();
	station.hostBoundaryKey = null;
	station.lastError = null;
	station.anchor = { persist() {}, rebase() {}, needsRebase: () => false };
	station.forkLedgerPort = () => ledger;
	station.forkIdentityPort = () => null;
	station.forkOwnerId = () => null;
	station.ownerId = null;
	station.childOutcomePort = () => null;
	station.noteError = () => {};
	station.currentContextTokens = () => 0;
	station.maybeRebase = () => {};
	station.accrueRentAndFlood = () => false;
	station.usage = {
		lastUsageModelKey: null,
		pricingHint: () => undefined,
		noteSentContext() {},
	};
	return station;
}

function childStation(ledger, forkId, messages = []) {
	const station = Object.create(SessionStation.prototype);
	station.state = createState();
	station.ports = bindStationPorts(station.state);
	station.manager = null;
	station.forkLedgerPort = () => ledger;
	station.forkIdentityPort = () => ({ forkId });
	station.forkOwnerId = () => forkId;
	station.ownerId = forkId;
	station.childOutcomePort = () => null;
	station.contextMessages = () => messages;
	station.persist = () => {};
	station.noteError = () => {};
	return station;
}

function assistantWith(callId, name, args = {}) {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		timestamp: 1,
	};
}

function toolResult(callId, name, text) {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

describe("adoption keeps the parent ahead of its children", () => {
	test("a returning parent queues before a child that was already ready", () => {
		const ledger = createBracketLedger();
		registerFork(ledger, {
			forkId: "p",
			ownerId: "root",
			levelKey: "root|0|0",
			fsm: "parent",
			depth: 0,
		});
		registerFork(ledger, {
			forkId: "c1",
			ownerId: "p",
			levelKey: "p|0|0",
			fsm: "child",
			depth: 1,
		});
		// The child finishes first; its record waits in the parent's queue.
		expect(markReady(ledger, "c1").ok).toBe(true);

		const out = handleReturnCall(childStation(ledger, "p"), {
			id: "return-p",
			arguments: { dafny: "the child did the work; record carries its text", ...OATH },
		});
		expect(out.isError).toBeUndefined();
		expect(forkOf(ledger, "c1").ownerId).toBe("root");

		// The grandparent must read the parent's own result first.
		expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("p");
		expect(takeReady(ledger, { ownerId: "root" }).fork.forkId).toBe("c1");
	});

	test("a return that cannot be marked ready moves no relationship", () => {
		const ledger = createBracketLedger();
		registerFork(ledger, {
			forkId: "p",
			ownerId: "root",
			levelKey: "root|0|0",
			fsm: "parent",
			depth: 0,
		});
		registerFork(ledger, {
			forkId: "c1",
			ownerId: "p",
			levelKey: "p|0|0",
			fsm: "child",
			depth: 1,
		});
		markReady(ledger, "p");
		// A second return cannot mark the same bracket ready again.
		const out = handleReturnCall(childStation(ledger, "p"), {
			id: "return-p-again",
			arguments: { dafny: "second return attempt: the bracket is already ready", ...OATH },
		});
		expect(out.isError).toBe(true);
		expect(forkOf(ledger, "c1").ownerId).toBe("p");
	});
});

describe("adoption files the result at the receiver's level", () => {
	test("a reparented child joins the grandparent's sibling chain", () => {
		const ledger = createBracketLedger();
		const state = createState();
		registerFork(ledger, {
			forkId: "p",
			ownerId: "root",
			levelKey: "root|0|0",
			fsm: "parent",
			depth: 0,
		});
		registerFork(ledger, {
			forkId: "c1",
			ownerId: "p",
			levelKey: "p|0|0",
			fsm: "child",
			depth: 1,
		});
		markReady(ledger, "c1");
		handleReturnCall(childStation(ledger, "p"), { id: "return-p", arguments: { dafny: "p returns so two children queue", ...OATH } });

		const root = rootStation(ledger, state);
		const first = handleJoinCall(root, { id: "j1", arguments: {} });
		expect(first.details.joined).toBe(true);
		const second = handleJoinCall(root, { id: "j2", arguments: {} });
		expect(second.details.joined).toBe(true);

		expect(ledger.levels["root|0|0"]).toEqual(["p", "c1"]);
	});
});

describe("a child record is frozen before the parent can take it", () => {
	test("return writes the child's own record, not the spawner's later copy", () => {
		const ledger = createBracketLedger();
		registerFork(ledger, {
			forkId: "p",
			ownerId: "root",
			levelKey: "root|0|0",
			fsm: "parent",
			depth: 0,
		});
		const outcomes = new Map();
		const station = childStation(ledger, "p", [
			{ role: "assistant", content: [{ type: "text", text: "the child did the work" }], timestamp: 1 },
		]);
		station.setChildOutcome = (forkId, outcome) => outcomes.set(forkId, outcome);

		const out = handleReturnCall(station, { id: "return-p", arguments: { dafny: "p returns: the child did the work", ...OATH } });
		expect(out.isError).toBeUndefined();
		expect(outcomes.get("p")?.record).toContain("the child did the work");
		expect(outcomes.get("p")?.failed).toBe(false);
	});
});

describe("the outbound projection keeps a plain record", () => {
	function projectionStation(state) {
		const station = rootStation(null, state);
		station.noteError = () => {};
		return station;
	}

	test("a join leaves the outbound messages untouched", () => {
		const state = createState();
		const messages = [
			assistantWith("f1", "scope_fork", { forks: [] }),
			toolResult("f1", "scope_fork", "[fork f1] State machine: \"probe\""),
			assistantWith("j1", "scope_join", {}),
			toolResult("j1", "scope_join", "full child record for f1"),
		];

		const station = projectionStation(state);
		const out = station.transformContext(messages, {});
		expect(out.messages).toHaveLength(messages.length);
		expect(out.messages[3].content[0].text).toBe("full child record for f1");
	});
});
