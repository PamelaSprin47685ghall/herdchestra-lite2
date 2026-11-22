// Contracts that make the three fork/join tools real: projection, adoption,
// child freeze and report discipline. Each case builds a station through the
// same ports the host wiring injects, never through a private field.

import { describe, expect, test } from "bun:test";

import { SessionStation } from "../src/station/station.mjs";
import { handleJoinCall, handleReturnCall } from "../src/station/fork-controls.mjs";
import {
	createBracketLedger,
	forkOf,
	markReady,
	registerFork,
	takeReady,
} from "../src/scope/forkjoin.mjs";
import {
	addReceipt,
	attachReport,
	createReceiptRecord,
} from "../src/scope/receipts.mjs";
import { createState } from "../src/scope/state.mjs";
import { createEmptyCatalog } from "../src/host/pricing.mjs";
import { createToolCallLedger } from "../src/station/domain/tool-call-ledger.mjs";

function receipt(forkId, closeId, closedOrder, levelKey = "root|0|0", report = null) {
	return createReceiptRecord({
		forkToolCallId: forkId,
		closeToolCallId: closeId,
		levelKey,
		closedOrder,
		report,
	});
}

/** A root station with only the ports the control handlers read. */
function rootStation(ledger, state = createState()) {
	const station = Object.create(SessionStation.prototype);
	station.state = state;
	station.manager = null;
	station.pricingCatalog = createEmptyCatalog();
	station.registry = { ports: () => ({ folding: "on" }) };
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
			intent: "parent",
			depth: 0,
		});
		registerFork(ledger, {
			forkId: "c1",
			ownerId: "p",
			levelKey: "p|0|0",
			intent: "child",
			depth: 1,
		});
		// The child finishes first; its record waits in the parent's queue.
		expect(markReady(ledger, "c1").ok).toBe(true);

		const out = handleReturnCall(childStation(ledger, "p"), {
			id: "return-p",
			arguments: {},
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
			intent: "parent",
			depth: 0,
		});
		registerFork(ledger, {
			forkId: "c1",
			ownerId: "p",
			levelKey: "p|0|0",
			intent: "child",
			depth: 1,
		});
		markReady(ledger, "p");
		// A second return cannot mark the same bracket ready again.
		const out = handleReturnCall(childStation(ledger, "p"), {
			id: "return-p-again",
			arguments: {},
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
			intent: "parent",
			depth: 0,
		});
		registerFork(ledger, {
			forkId: "c1",
			ownerId: "p",
			levelKey: "p|0|0",
			intent: "child",
			depth: 1,
		});
		markReady(ledger, "c1");
		handleReturnCall(childStation(ledger, "p"), { id: "return-p", arguments: {} });

		const root = rootStation(ledger, state);
		const first = handleJoinCall(root, { id: "j1", arguments: { elder_report: null } });
		expect(first.details.joined).toBe(true);
		const second = handleJoinCall(root, {
			id: "j2",
			arguments: { elder_report: "parent said what it found" },
		});
		expect(second.details.joined).toBe(true);

		const c1Receipt = state.receipts.find((entry) => entry.closeToolCallId === "j2");
		expect(c1Receipt.levelKey).toBe("root|0|0");
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
			intent: "parent",
			depth: 0,
		});
		const outcomes = new Map();
		const station = childStation(ledger, "p", [
			{ role: "assistant", content: [{ type: "text", text: "the child did the work" }], timestamp: 1 },
		]);
		station.setChildOutcome = (forkId, outcome) => outcomes.set(forkId, outcome);

		const out = handleReturnCall(station, { id: "return-p", arguments: {} });
		expect(out.isError).toBeUndefined();
		expect(outcomes.get("p")?.record).toContain("the child did the work");
		expect(outcomes.get("p")?.failed).toBe(false);
	});
});

describe("elder_report is exact", () => {
	test("a summary with no pending receipt is accepted and noted", () => {
		const ledger = createBracketLedger();
		registerFork(ledger, {
			forkId: "c1",
			ownerId: "root",
			levelKey: "root|0|0",
			intent: "child",
			depth: 0,
		});
		markReady(ledger, "c1");
		const station = rootStation(ledger);

		const out = handleJoinCall(station, {
			id: "j1",
			arguments: { elder_report: "nothing is pending" },
		});
		expect(out.isError).toBeUndefined();
		expect(out.details.joined).toBe(true);
		expect(out.details.elderUnneeded).toBe(true);
		expect(out.content[0].text).toContain("was accepted but not stored");
		// The stray report changes nothing; the child is still received.
		expect(forkOf(ledger, "c1").status).toBe("joined");
	});

	test("a pending receipt demands a non-empty summary", () => {
		const ledger = createBracketLedger();
		const state = createState();
		state.receipts = addReceipt([], receipt("f0", "j0", 1));
		registerFork(ledger, {
			forkId: "c1",
			ownerId: "root",
			levelKey: "root|0|0",
			intent: "child",
			depth: 0,
		});
		markReady(ledger, "c1");
		const station = rootStation(ledger, state);

		const out = handleJoinCall(station, {
			id: "j1",
			arguments: { elder_report: null },
		});
		expect(out.isError).toBe(true);
		expect(forkOf(ledger, "c1").status).toBe("ready");
	});
});

describe("the outbound projection shortens receipts", () => {
	function projectionStation(state) {
		const station = rootStation(null, state);
		station.registry = { ports: () => ({}) };
		station.noteError = () => {};
		return station;
	}

	test("a foldable receipt loses its work text and keeps both brackets", () => {
		const state = createState();
		let receipts = addReceipt([], receipt("f1", "j1", 1));
		receipts = addReceipt(receipts, receipt("f2", "j2", 2));
		receipts = attachReport(receipts, "j1", "found the parser path");
		state.receipts = receipts;

		const messages = [
			assistantWith("f1", "scope_fork", { forks: [] }),
			toolResult("f1", "scope_fork", "[fork f1] intent: \"probe\""),
			assistantWith("j1", "scope_join", { elder_report: null }),
			toolResult(
				"j1",
				"scope_join",
				'full child record for f1\n' +
					"work text that must disappear. ".repeat(20) +
					'\n[fork g1] intent: "grandchild" | budget: read 1',
			),
			assistantWith("j2", "scope_join", { elder_report: "found the parser path" }),
			toolResult("j2", "scope_join", "the youngest record stays complete"),
		];

		const station = projectionStation(state);
		const out = station.transformContext(messages, {});
		const texts = out.messages.map((message) =>
			typeof message.content === "string"
				? message.content
				: (message.content ?? []).map((block) => block.text ?? "").join(""),
		);

		expect(texts[3]).toContain("found the parser path");
		expect(texts[3]).not.toContain("full child record for f1");
		expect(texts[3]).toContain("[fork g1]");
		expect(texts[5]).toBe("the youngest record stays complete");
		expect(out.messages[0]).toBe(messages[0]);
		expect(out.messages[1]).toBe(messages[1]);
	});
});
