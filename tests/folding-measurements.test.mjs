/**
 * Measured facts the folding economics stands on: dialogue density, the
 * constant prefix no dialogue character explains, baseline rebasing across a
 * fold, and cache positions merged after adoption.
 */

import { describe, expect, test } from "bun:test";
import { createUsageLedger } from "../src/scope/usage-ledger.mjs";
import { mergeModelCaches } from "../src/host/fission-scheduler.mjs";
import { netRemovableTokens, sliceChars } from "../src/station/fold.mjs";

const KEY = "prov/model";

function ledgerFor(state, messages) {
	return createUsageLedger({
		state,
		contextMessages: () => messages,
		persist: () => {},
		foldBatch: () => ({ rebased: false }),
		noteError: () => {},
		sliceChars,
		netRemovableTokens,
		modelKeyOf: (message) =>
			message?.provider && message?.model
				? `${message.provider}/${message.model}`
				: null,
		actualModelOf: () => null,
	});
}

function emptyState() {
	return { modelCaches: {}, scopes: [], collapses: [], epoch: 0 };
}

function assistant(extra = {}) {
	return { role: "assistant", provider: "prov", model: "model", ...extra };
}

describe("dialogue density", () => {
	test("two aligned samples measure dialogue, not the fixed prefix", () => {
		const state = emptyState();
		const messages = [assistant({ content: "a".repeat(4000) })];
		const ledger = ledgerFor(state, messages);
		ledger.sentContext = { key: KEY, chars: 4000, frontier: 1 };
		ledger.onMessage(
			assistant({ content: "a".repeat(4000), usage: { input: 20000 } }),
			null,
		);
		// A ratio of total input to dialogue characters clamps at the ceiling.
		expect(state.modelCaches[KEY].tokensPerChar).toBeCloseTo(0.8, 6);

		// 2,000 more characters cost 700 more input tokens: 0.35 tokens/char.
		messages.push(assistant({ content: "b".repeat(2000) }));
		ledger.sentContext = { key: KEY, chars: 6000, frontier: 2 };
		ledger.onMessage(
			assistant({ content: "b".repeat(2000), usage: { input: 20700 } }),
			null,
		);

		expect(state.modelCaches[KEY].tokensPerChar).toBeCloseTo(0.35, 6);
		expect(state.modelCaches[KEY].fixedOverheadTokens).toBeCloseTo(18600, 6);
	});

	test("a shrinking outbound list voids the sample", () => {
		const state = emptyState();
		const messages = [assistant({ content: "a".repeat(4000) })];
		const ledger = ledgerFor(state, messages);
		ledger.sentContext = { key: KEY, chars: 4000, frontier: 1 };
		ledger.onMessage(
			assistant({ content: "a".repeat(4000), usage: { input: 20000 } }),
			null,
		);
		const before = state.modelCaches[KEY].tokensPerChar;

		messages.push(assistant({ content: "b".repeat(10) }));
		ledger.sentContext = { key: KEY, chars: 10, frontier: 2 };
		ledger.onMessage(
			assistant({ content: "b".repeat(10), usage: { input: 30000 } }),
			null,
		);

		expect(state.modelCaches[KEY].tokensPerChar).toBeCloseTo(before, 6);
	});

	test("a model switch pays the recorded fixed prefix", () => {
		const state = emptyState();
		const messages = [assistant({ content: "a".repeat(1000) })];
		state.modelCaches[KEY] = {
			cachedUntilPos: 0,
			lastUsedAt: Date.now(),
			tokensPerChar: 0.3,
			fixedOverheadTokens: 15000,
		};
		const ledger = ledgerFor(state, messages);
		ledger.lastUsageModelKey = "other/old";
		ledger.lastTotalInput = 900;

		expect(ledger.currentContextTokens(messages, KEY)).toBeCloseTo(
			15000 + 300,
			6,
		);
	});
});

describe("baseline rebasing", () => {
	test("moves the hot workbench down and leaves folded records alone", () => {
		const state = emptyState();
		state.collapses.push(
			{ order: 1, collapsed: true, baseModelKey: KEY, baseInputTokens: 5000 },
			{
				order: 3,
				collapsed: false,
				baseModelKey: KEY,
				baseInputTokens: 9000,
				preBeginInputTokens: 8000,
				endInputTokens: 9500,
			},
		);
		const ledger = ledgerFor(state, []);
		ledger.lastUsageModelKey = KEY;
		ledger.lastTotalInput = 10000;
		ledger.rebase({ savedTokens: 2000, maxOrder: 1 });

		expect(state.collapses[0].baseInputTokens).toBe(5000);
		expect(state.collapses[1].baseInputTokens).toBe(7000);
		expect(state.collapses[1].preBeginInputTokens).toBe(6000);
		expect(state.collapses[1].endInputTokens).toBe(7500);
		expect(ledger.lastTotalInput).toBe(8000);
	});
});

describe("cached position after adoption", () => {
	test("the newer writer wins", () => {
		const merged = mergeModelCaches(
			{ [KEY]: { cachedUntilPos: 4, lastUsedAt: 1000 } },
			{ [KEY]: { cachedUntilPos: 12, lastUsedAt: 2000 } },
		);
		expect(merged[KEY].cachedUntilPos).toBe(12);
	});

	test("equally fresh entries keep the heir's position", () => {
		const merged = mergeModelCaches(
			{ [KEY]: { cachedUntilPos: 4, lastUsedAt: 1000 } },
			{ [KEY]: { cachedUntilPos: 12, lastUsedAt: 1000 } },
		);
		expect(merged[KEY].cachedUntilPos).toBe(12);
	});
});
