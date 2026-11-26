// Snapshot sharing and ownership for the persistence hot path.
//
// Two serializers, two contracts:
// - `serializeStateShared` / `serializeStateCore` may hand back the very table
//   a previous call returned, so an untouched ledger costs no copy and no
//   diff. The result is read-only.
// - `serializeState` promises objects the caller owns: every table is rebuilt,
//   so two snapshots can be held at once and one written without disturbing the
//   other.
//
// The retired pin/amend/charge tables are gone; the tables that still exist
// (`brackets`, `modelCaches`) are what these tests pin.

import { expect, test } from "bun:test";
import {
	serializeState,
	serializeStateCore,
	serializeStateShared,
} from "../src/scope/persistence.mjs";
import { createBracketLedger, registerFork } from "../src/scope/forkjoin.mjs";
import { createState } from "../src/scope/state.mjs";
import { diffState } from "../src/scope/persistence.mjs";

function ledgerWithFork() {
	const ledger = createBracketLedger();
	expect(
		registerFork(ledger, {
			forkId: "alpha",
			ownerId: "root",
			levelKey: "root|0|0",
			fsm: "work alpha",
			depth: 0,
			budget: { read: 3 },
			startedAt: 1_000,
		}).ok,
	).toBe(true);
	return ledger;
}

test("an unchanged bracket tree keeps its identity on the shared path", () => {
	const state = createState();
	state.brackets = ledgerWithFork();
	const first = serializeStateShared(state);
	const second = serializeStateShared(state);
	// Identity is what lets `diffState` skip the tree instead of walking every
	// fork and finding nothing.
	expect(second.brackets).toBe(first.brackets);
	expect(second.brackets.forks.alpha).toBe(first.brackets.forks.alpha);
	expect(diffState(first, second)).toEqual([]);
});

test("the core hot path shares the model cache table it did not change", () => {
	const state = createState();
	state.modelCaches = {
		"provider/model": { lastUsedAt: 1, tokensPerChar: 0.3, fixedOverheadTokens: 10 },
	};
	const first = serializeStateCore(state);
	const second = serializeStateCore(state);
	expect(second.modelCaches).toBe(first.modelCaches);
	expect(diffState(first, second)).toEqual([]);
});

test("serializeState hands the caller its own tables", () => {
	const state = createState();
	state.brackets = ledgerWithFork();
	state.modelCaches = {
		"provider/model": { lastUsedAt: 1, tokensPerChar: 0.3, fixedOverheadTokens: 10 },
	};
	const first = serializeState(state);
	const second = serializeState(state);
	// A caller holding two snapshots may write one and still read the other.
	expect(second.brackets).not.toBe(first.brackets);
	expect(second.modelCaches).not.toBe(first.modelCaches);
	expect(second.modelCaches["provider/model"]).not.toBe(first.modelCaches["provider/model"]);

	first.brackets.forks.alpha.status = "tampered";
	first.modelCaches["provider/model"].tokensPerChar = 99;
	expect(second.brackets.forks.alpha.status).toBe("running");
	expect(second.modelCaches["provider/model"].tokensPerChar).toBe(0.3);
	expect(state.brackets.forks.alpha.status).toBe("running");
});

test("a new model cache entry appears as one set delta", () => {
	const state = createState();
	const first = serializeStateShared(state);
	state.modelCaches.added = { lastUsedAt: 2, tokensPerChar: 0.5, fixedOverheadTokens: 0 };
	const second = serializeStateShared(state);
	expect(second.modelCaches).not.toBe(first.modelCaches);
	// The earlier snapshot is a baseline, not a view: it still holds what it held.
	expect(first.modelCaches.added).toBeUndefined();
	expect(diffState(first, second)).toEqual([
		{
			op: "set",
			path: ["modelCaches", "added"],
			value: { lastUsedAt: 2, tokensPerChar: 0.5, fixedOverheadTokens: 0 },
		},
	]);
});

test("a moved fork record is re-serialized, its siblings are shared", () => {
	const state = createState();
	state.brackets = ledgerWithFork();
	const first = serializeStateShared(state);
	expect(
		registerFork(state.brackets, {
			forkId: "beta",
			ownerId: "root",
			levelKey: "root|0|1",
			fsm: "work beta",
			depth: 0,
			budget: { read: 1 },
			startedAt: 1_000,
		}).ok,
	).toBe(true);
	const second = serializeStateShared(state);
	expect(second.brackets).not.toBe(first.brackets);
	// The untouched fork keeps its object identity across the two snapshots.
	expect(second.brackets.forks.alpha).toBe(first.brackets.forks.alpha);
	expect(second.brackets.forks.beta).toBeDefined();
	expect(first.brackets.forks.beta).toBeUndefined();
});

test("an unchanged call still yields an empty delta", () => {
	const state = createState();
	state.brackets = ledgerWithFork();
	const previous = serializeStateShared(state);
	const next = serializeStateShared(state);
	expect(diffState(previous, next)).toEqual([]);
});
