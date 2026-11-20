import { describe, expect, test } from "bun:test";

import { createState } from "../src/scope/index.mjs";
import { handleScopeCall } from "../src/station/controls.mjs";
import { createEmptyCatalog } from "../src/host/pricing.mjs";

/**
 * The pre-fission begin path ran the economics decision on every open. The
 * fission refactor moved beginnings into `handleFissionBegin` and dropped that
 * call, so `shouldFoldPool` only ever ran on a model change at scope end and
 * pools accrued rent without ever reaching a decision.
 *
 * This case drives the begin handler with a pool that is obviously worth
 * folding and asserts the fold actually ran. Without the restored call the
 * stub records nothing and the test fails.
 */

const BEGIN_CALL = "call-begin";
const END_CALL = "call-end";

function scopeCall(id, args) {
	return { id, name: "scope", arguments: args };
}

function callBlock(id) {
	return { type: "toolCall", id, name: "scope", arguments: {} };
}

function beginBatch() {
	return {
		stage: "architecture-design",
		elder_report: null,
		time: 60,
		fission: [{ intent: "flow", budget: { read: 2 }, permission: "ro" }],
	};
}

/** A transcript holding one finished scope, so its interior is addressable. */
function baseWithScope() {
	return [
		{ role: "assistant", content: [callBlock(BEGIN_CALL)], timestamp: 1 },
		{ role: "toolResult", toolCallId: BEGIN_CALL, content: [{ type: "text", text: "begin" }], timestamp: 2 },
		{ role: "assistant", content: [{ type: "text", text: "interior" }], timestamp: 3 },
		{ role: "assistant", content: [callBlock(END_CALL)], timestamp: 4 },
		{ role: "toolResult", toolCallId: END_CALL, content: [{ type: "text", text: "end" }], timestamp: 5 },
	];
}

function foldableRecord(boundary, epoch) {
	return {
		scopeId: "scope-1",
		intent: "elder",
		beginToolCallId: BEGIN_CALL,
		endToolCallId: END_CALL,
		report: "done",
		parentId: null,
		order: 1,
		boundary,
		epoch,
		collapsed: false,
		sealed: false,
		interiorChars: 100_000,
		interiorTokens: 50_000,
		pinChars: 0,
		pinTokens: 0,
		userChars: 0,
		paidRentCost: 1_000_000_000,
	};
}

/**
 * A second record with a higher order is the hot workbench. Without it the
 * candidate is its own workbench, and `findFoldablePool` requires a pool
 * member to sit strictly behind one.
 */
function workbenchRecord(boundary, epoch) {
	const record = foldableRecord(boundary, epoch);
	record.scopeId = "scope-2";
	record.intent = "workbench";
	record.beginToolCallId = "call-hot-begin";
	record.endToolCallId = "call-hot-end";
	record.report = "hot";
	record.order = 2;
	return record;
}

function makeStation(base) {
	const folds = [];
	const scheduler = {
		registerBatch: () => ({ ok: true, batchId: "b1", batch: { id: "b1" }, batchBeginId: "e1" }),
		cancelBatch: () => {},
		retireOwner: () => ({ ok: true }),
	};
	const state = createState();
	state.baseModelKey = "test/model";
	// `findFoldablePool` matches on the level's boundary and epoch; take them
	// from the live state instead of assuming zero.
	const boundary = state.relay?.generation ?? 0;
	const epoch = state.epoch ?? 0;
	state.collapses.push(foldableRecord(boundary, epoch), workbenchRecord(boundary, epoch));
	const station = {
		state,
		usage: { lastTotalInput: 1000, lastOutputTokens: 10, lastUsageCost: null, lastUsageModelKey: "test/model" },
		pricingCatalog: createEmptyCatalog(),
		manager: { getSessionId: () => "session-1" },
		registry: { fissionScheduler: () => scheduler },
		policy: () => "main",
		relayOn: () => false,
		findBeginEntry: () => ({ toolCallId: BEGIN_CALL }),
		pendingFission: null,
		observeActualModel: () => {},
		currentContextTokens: () => 0,
		tokensPerCharFor: () => 0.3,
		usagePricingHint: () => undefined,
		foldBatch(args) {
			folds.push(args);
			return { foldedCount: 1, savedTokens: 1, rebased: false, maxOrder: 1, foldStartIdx: 0 };
		},
		rebaseBaselines: () => {},
		persist: () => {},
	};
	return { station, folds, base };
}

describe("fission begin runs the economics decision", () => {
	test("folds an elder that is obviously worth folding", () => {
		const base = baseWithScope();
		const { station, folds } = makeStation(base);
		const ctx = { agent: { id: "owner", kind: "main" }, abort: () => {} };

		const result = handleScopeCall(station, scopeCall(BEGIN_CALL, { begin: beginBatch() }), {
			ctx,
			base,
			currentMessage: null,
			currentPersisted: false,
		});

		expect(result.isError).toBeUndefined();
		expect(folds).toHaveLength(1);
		expect(folds[0].batch).toHaveLength(1);
	});

	test("leaves the elder alone when the pool is not worth folding", () => {
		const base = baseWithScope();
		const { station, folds } = makeStation(base);
		const record = station.state.collapses[0];
		record.paidRentCost = 0;
		record.interiorChars = 1;
		record.interiorTokens = 1;
		const ctx = { agent: { id: "owner", kind: "main" }, abort: () => {} };

		handleScopeCall(station, scopeCall(BEGIN_CALL, { begin: beginBatch() }), {
			ctx,
			base,
			currentMessage: null,
			currentPersisted: false,
		});

		expect(folds).toHaveLength(0);
	});
});
