/**
 * Context-bloat degradation economics: the efficiency curve, the Bellman
 * identity shared by future savings and sunk rent, decision flips at realistic
 * context sizes, and per-record rent distribution.
 */

import { describe, expect, test } from "bun:test";

import {
	createState,
	createUsageLedger,
	contextEfficiency,
	futureFoldSavings,
	poolTurnRent,
} from "../src/scope/index.mjs";
import { shouldFoldPool, netRemovableTokens, sliceChars } from "../src/station/fold.mjs";
import { resolveModelPolicy } from "../src/host/pricing.mjs";

const WINDOW = 200_000;
const PRICING = {
	pHit: 0.3e-6,
	pMiss: 3.75e-6,
	pOut: 15e-6,
	contextWindow: WINDOW,
};
const NON_CONTEXT = 1500 * 15e-6 + 4000 * 3.75e-6;

function poolRecord({ interiorTokens, baseInputTokens }) {
	return {
		collapsed: false,
		report: "done",
		interiorTokens,
		pinTokens: 0,
		pinChars: 0,
		userChars: 0,
		paidRentCost: 0,
		baseInputTokens,
		beginToolCallId: "bg",
		endToolCallId: "ed",
		order: 1,
		epoch: 0,
	};
}

function decision({
	budget,
	interiorTokens,
	lastTotalInput,
	baseInputTokens,
	contextTokens,
	contextWindow = WINDOW,
	avgOutput = 1500,
}) {
	return shouldFoldPool({
		pool: [poolRecord({ interiorTokens, baseInputTokens })],
		state: { epoch: 0 },
		base: [],
		budget,
		usageSnapshot: {
			lastTotalInput,
			lastOutput: avgOutput,
			avgOutput,
			avgTurnGrowth: 4000,
		},
		pricing: { ...PRICING, contextWindow },
		contextTokens,
		tokensPerChar: 0.3,
	});
}

function ledgerFor(state, messages) {
	return createUsageLedger({
		state,
		contextMessages: () => messages,
		persist: () => {},
		foldBatch: () => ({ rebased: false }),
		noteError: (_domain, error) => {
			throw error;
		},
		sliceChars,
		netRemovableTokens,
		modelKeyOf: (message) =>
			message?.provider && message?.model
				? `${message.provider}/${message.model}`
				: null,
		actualModelOf: () => null,
	});
}

describe("efficiency curve", () => {
	test("falls linearly from 1 to 1/2 and clamps at a full window", () => {
		expect(contextEfficiency(0, WINDOW)).toBe(1);
		expect(contextEfficiency(WINDOW / 2, WINDOW)).toBeCloseTo(0.75);
		expect(contextEfficiency(WINDOW, WINDOW)).toBeCloseTo(0.5);
		expect(contextEfficiency(1.5 * WINDOW, WINDOW)).toBeCloseTo(0.5);
	});

	test("unknown window or context is no degradation", () => {
		expect(contextEfficiency(120_000, null)).toBe(1);
		expect(contextEfficiency(0, WINDOW)).toBe(1);
		expect(contextEfficiency(Number.POSITIVE_INFINITY, WINDOW)).toBe(1);
	});
});

describe("Bellman consistency", () => {
	const cases = [
		{ C: 120_000, B: 30_000, work: 6 },
		{ C: 180_000, B: 40_000, work: 5 },
		{ C: 250_000, B: 40_000, work: 6 },
		{ C: 20_000, B: 50_000, work: 4 },
	];

	test("sunk rent over the kept turns equals future savings", () => {
		for (const { C, B, work } of cases) {
			const rent = poolTurnRent({
				poolTokens: B,
				contextTokens: C,
				contextWindow: WINDOW,
				pHit: PRICING.pHit,
				nonContextTurnCost: NON_CONTEXT,
			});
			const savings = futureFoldSavings({
				nominalWork: work,
				poolTokens: B,
				uncachedTokens: 0,
				contextTokens: C,
				contextWindow: WINDOW,
				pHit: PRICING.pHit,
				pMiss: PRICING.pMiss,
				nonContextTurnCost: NON_CONTEXT,
			});
			expect(savings.nKeep * rent.total).toBeCloseTo(savings.total, 12);
			// Above the window the curve saturates at 1/2, so folding a pool
			// that leaves both sides over the limit buys no extra turns; the
			// direct read rent is the floor.
			expect(rent.total).toBeGreaterThanOrEqual(B * PRICING.pHit);
		}
		const degraded = poolTurnRent({
			poolTokens: 30_000,
			contextTokens: 120_000,
			contextWindow: WINDOW,
			pHit: PRICING.pHit,
			nonContextTurnCost: NON_CONTEXT,
		});
		expect(degraded.total).toBeGreaterThan(30_000 * PRICING.pHit);
	});

	test("rent degrades to the direct read when the window is unknown", () => {
		const rent = poolTurnRent({
			poolTokens: 30_000,
			contextTokens: 120_000,
			contextWindow: null,
			pHit: PRICING.pHit,
			nonContextTurnCost: NON_CONTEXT,
		});
		expect(rent.degradation).toBe(0);
		expect(rent.total).toBeCloseTo(30_000 * PRICING.pHit);
	});
});

describe("fold decisions under context pressure", () => {
	test("low context holds: the rebuild premium still exceeds the savings", () => {
		const low = decision({
			budget: { read: 5 },
			interiorTokens: 10_000,
			lastTotalInput: 40_000,
			baseInputTokens: 10_000,
			contextTokens: 40_000,
		});
		expect(low.fold).toBe(false);
		expect(low.reason).toBe("hold");
	});

	test("60% context flips from hold to fold once degradation is priced", () => {
		const withoutWindow = decision({
			budget: { read: 7 },
			interiorTokens: 30_000,
			lastTotalInput: 120_000,
			baseInputTokens: 60_000,
			contextTokens: 120_000,
			contextWindow: null,
		});
		expect(withoutWindow.fold).toBe(false);
		expect(withoutWindow.degradationValue).toBe(0);

		const withWindow = decision({
			budget: { read: 7 },
			interiorTokens: 30_000,
			lastTotalInput: 120_000,
			baseInputTokens: 60_000,
			contextTokens: 120_000,
		});
		expect(withWindow.fold).toBe(true);
		expect(withWindow.reason).toBe("economics");
		expect(withWindow.degradationValue).toBeGreaterThan(0);
		expect(withWindow.value).toBeGreaterThan(withoutWindow.value);
	});

	test("higher output makes the same context pressure decisive", () => {
		const options = {
			budget: { read: 7 },
			interiorTokens: 30_000,
			lastTotalInput: 120_000,
			baseInputTokens: 49_420,
			contextTokens: 120_000,
		};
		const cheapOutput = decision({ ...options, avgOutput: 1500 });
		const heavyThinking = decision({ ...options, avgOutput: 4000 });
		expect(cheapOutput.fold).toBe(false);
		expect(heavyThinking.fold).toBe(true);
		expect(heavyThinking.value).toBeGreaterThan(cheapOutput.value);
		expect(heavyThinking.degradationValue).toBeGreaterThan(
			cheapOutput.degradationValue,
		);
	});
});

describe("accrued rent", () => {
	const KEY = "test/model";

	function rentState() {
		const state = createState();
		state.modelCaches[KEY] = { tokensPerChar: 0.3 };
		const record = (order, interiorTokens) => ({
			collapsed: false,
			report: "done",
			interiorTokens,
			pinTokens: 0,
			pinChars: 0,
			userChars: 0,
			paidRentCost: 0,
			measuredModelKey: KEY,
			parentId: null,
			boundary: 0,
			epoch: 0,
			order,
			beginToolCallId: `begin-${order}`,
			endToolCallId: `end-${order}`,
		});
		const first = record(1, 4_000);
		const second = record(2, 2_000);
		const hot = record(3, 8_000);
		state.collapses.push(first, second, hot);
		const ledger = ledgerFor(state, []);
		ledger.avgOutputTokens = 1500;
		ledger.avgTurnGrowthTokens = 4000;
		return { state, ledger, first, second };
	}

	test("distributes level rent by removable tokens", () => {
		const { ledger, first, second } = rentState();
		ledger.accrue([], PRICING, 120_000, KEY);
		const b1 = netRemovableTokens(first, 0.3, KEY);
		const b2 = netRemovableTokens(second, 0.3, KEY);
		const expected = poolTurnRent({
			poolTokens: b1 + b2,
			contextTokens: 120_000,
			contextWindow: WINDOW,
			pHit: PRICING.pHit,
			nonContextTurnCost: NON_CONTEXT,
		}).total;
		expect(expected).toBeGreaterThan((b1 + b2) * PRICING.pHit);
		expect(first.paidRentCost).toBeCloseTo(expected * (b1 / (b1 + b2)), 12);
		expect(second.paidRentCost).toBeCloseTo(expected * (b2 / (b1 + b2)), 12);
		expect(first.paidRentCost + second.paidRentCost).toBeCloseTo(expected, 12);
	});

	test("unknown window accrues only the direct read rent", () => {
		const { ledger, first, second } = rentState();
		ledger.accrue([], { ...PRICING, contextWindow: null }, 120_000, KEY);
		expect(first.paidRentCost).toBeCloseTo(
			netRemovableTokens(first, 0.3, KEY) * PRICING.pHit,
			12,
		);
		expect(second.paidRentCost).toBeCloseTo(
			netRemovableTokens(second, 0.3, KEY) * PRICING.pHit,
			12,
		);
	});
});

describe("pricing hint", () => {
	test("keeps the token counts so usage-derived prices can be rebuilt", () => {
		const state = createState();
		const message = {
			role: "assistant",
			provider: "test",
			model: "m",
			content: [],
			usage: {
				input: 1000,
				cacheRead: 5000,
				output: 200,
				cost: { input: 0.003, cacheRead: 0.0015, output: 0.003 },
			},
		};
		const messages = [message];
		const ledger = ledgerFor(state, messages);
		ledger.onMessage(message, null);
		expect(ledger.avgOutputTokens).toBe(200);
		expect(ledger.lastUsageSnapshot.cacheRead).toBe(5000);
		const policy = resolveModelPolicy(null, {}, ledger.pricingHint());
		expect(policy.pHit).toBeCloseTo(0.0015 / 5000, 12);
		expect(policy.pMiss).toBeCloseTo(0.003 / 1000, 12);
		expect(policy.pOut).toBeCloseTo(0.003 / 200, 12);
	});
});
