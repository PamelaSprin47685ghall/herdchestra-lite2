// The context-midpoint nudge: arithmetic, arming, re-baselining, injection.
//
// The decision has four inputs nobody else may guess: the occupancy the last
// response ended at, the occupancy this scope was born at, the model's input
// limit, and nothing else. Three of them can be unknown, and every unknown
// case is asserted here to refuse rather than to arm.

import { describe, expect, test } from "bun:test";
import {
	contextMidpoint,
	contextNudgeArmed,
} from "../src/scope/context-nudge.mjs";
import { createUsageLedger } from "../src/scope/usage-ledger.mjs";
import { createState } from "../src/scope/state.mjs";
import { injectSystemPrompt } from "../src/prompts/inject.mjs";
import { loadDoc } from "../src/prompts/index.mjs";
import { skillReceiptText } from "../src/station/texts.mjs";

const nudgeText = loadDoc("receipts/scope")["context.nudge"];

/** A ledger whose window is fixed by the test, not by a host. */
function ledgerWith(window) {
	return createUsageLedger({
		state: createState(),
		contextMessages: () => [],
		persist() {},
		noteError() {},
		modelKeyOf: () => "model",
		actualModelOf: () => null,
		window: () => window,
	});
}

/** One measured assistant response as the host reports it. */
function response(ledger, input, output = 100) {
	ledger.onMessage({
		role: "assistant",
		provider: "test",
		model: "model",
		usage: { input, output, cacheRead: 0, cacheWrite: 0 },
	}, null);
}

describe("contextMidpoint", () => {
	test("halves the interval between birth and limit", () => {
		expect(contextMidpoint({ baseline: 1000, window: 10000 })).toBe(5500);
		expect(contextMidpoint({ baseline: 0, window: 100 })).toBe(50);
	});

	test("names no midpoint when an input is unknown or the interval is empty", () => {
		expect(contextMidpoint({ baseline: null, window: 10000 })).toBeNull();
		expect(contextMidpoint({ baseline: 1000, window: null })).toBeNull();
		expect(contextMidpoint({ baseline: 1000, window: 1000 })).toBeNull();
		// A baseline already past a smaller window has no room to halve, so the
		// arithmetic would return a value below the baseline. It refuses instead
		// of inventing a backward threshold.
		expect(contextMidpoint({ baseline: 5000, window: 1000 })).toBeNull();
		expect(contextMidpoint({ baseline: 1000, window: 0 })).toBeNull();
		expect(contextMidpoint({ baseline: -1, window: 10000 })).toBeNull();
		expect(contextMidpoint({ baseline: 1000, window: Number.POSITIVE_INFINITY })).toBeNull();
	});
});

describe("contextNudgeArmed", () => {
	test("strictly above the midpoint arms", () => {
		expect(contextNudgeArmed({ occupancy: 5400, baseline: 1000, window: 10000 })).toBe(false);
		// Equality is the point where continuing still pays: the nudge starts
		// one token later.
		expect(contextNudgeArmed({ occupancy: 5500, baseline: 1000, window: 10000 })).toBe(false);
		expect(contextNudgeArmed({ occupancy: 5501, baseline: 1000, window: 10000 })).toBe(true);
	});

	test("a baseline at or past the window arms at once", () => {
		expect(contextNudgeArmed({ occupancy: 5000, baseline: 5000, window: 5000 })).toBe(true);
		expect(contextNudgeArmed({ occupancy: 5000, baseline: 9000, window: 5000 })).toBe(true);
	});

	test("an unknown input never arms and never runs the division", () => {
		expect(contextNudgeArmed({ occupancy: 9000, baseline: 1000, window: null })).toBe(false);
		expect(contextNudgeArmed({ occupancy: 9000, baseline: null, window: 10000 })).toBe(false);
		expect(contextNudgeArmed({ occupancy: null, baseline: 1000, window: 10000 })).toBe(false);
		expect(contextNudgeArmed({ occupancy: 9000, baseline: 1000, window: 0 })).toBe(false);
		expect(contextNudgeArmed({ occupancy: 9000, baseline: 1000, window: -5 })).toBe(false);
		expect(contextNudgeArmed({ occupancy: 9000, baseline: 1000, window: Number.NaN })).toBe(false);
	});
});

describe("arming on a live ledger", () => {
	test("the first measured response is the baseline, not a zero", () => {
		const ledger = ledgerWith(10000);
		expect(ledger.baselineTokens).toBeNull();
		// An unmeasured scope has no occupancy, so nothing arms.
		expect(ledger.contextNudge).toBe(false);
		response(ledger, 1000);
		expect(ledger.baselineTokens).toBe(1000);
		expect(ledger.contextNudge).toBe(false);
	});

	test("crossing the midpoint arms the next request, descending disarms it", () => {
		const ledger = ledgerWith(10000);
		response(ledger, 1000);
		expect(ledger.contextNudge).toBe(false);
		response(ledger, 5400);
		// 5400 + 100 output = 5500, exactly the midpoint: still not armed.
		expect(ledger.contextNudge).toBe(false);
		response(ledger, 5401);
		expect(ledger.contextNudge).toBe(true);
		// A fold reclaims room below the midpoint and the scope is left alone.
		ledger.rebase({ savedTokens: 2000 });
		expect(ledger.contextNudge).toBe(false);
	});

	test("a rewind re-baselines at the new birth", () => {
		const ledger = ledgerWith(10000);
		response(ledger, 1000);
		response(ledger, 6000);
		expect(ledger.contextNudge).toBe(true);
		ledger.resetWatermark();
		expect(ledger.baselineTokens).toBeNull();
		expect(ledger.contextNudge).toBe(false);
		// The scope's new birth is a small context, so the same absolute input
		// that used to arm no longer does: the midpoint moved up.
		response(ledger, 2000);
		expect(ledger.baselineTokens).toBe(2000);
		expect(ledger.contextNudge).toBe(false);
		response(ledger, 5900);
		expect(ledger.contextNudge).toBe(false);
		response(ledger, 6001);
		expect(ledger.contextNudge).toBe(true);
	});

	test("an unknown window never arms, however large the context grows", () => {
		const ledger = ledgerWith(null);
		response(ledger, 1000);
		response(ledger, 900000);
		expect(ledger.baselineTokens).toBe(1000);
		expect(ledger.contextNudge).toBe(false);
	});

	test("a scope born past its window arms on the first response", () => {
		const ledger = ledgerWith(1000);
		response(ledger, 5000);
		expect(ledger.baselineTokens).toBe(5000);
		expect(ledger.contextNudge).toBe(true);
	});

	test("a zero-usage response is not a measurement", () => {
		const ledger = ledgerWith(10000);
		response(ledger, 1000);
		ledger.onMessage({
			role: "assistant",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}, null);
		expect(ledger.baselineTokens).toBe(1000);
		expect(ledger.contextNudge).toBe(false);
	});
});

describe("trailing injection", () => {
	test("the nudge is a skill block, and only when the scope is armed", () => {
		const quiet = skillReceiptText({}, null, 0, false, null, "on", false);
		expect(quiet).not.toContain(nudgeText);
		expect(quiet).toContain("<additional-system-instructions>");

		const armed = skillReceiptText({}, null, 0, false, null, "on", true);
		expect(armed).toContain(`<skill version="1.0" enforced>${nudgeText}</skill>`);
		// It urges the return, and it is a skill, not a receipt line.
		expect(armed).toContain("scope_return");
	});

	test("the nudge follows the existing children instead of replacing them", () => {
		const state = { autopilot: false };
		const armed = skillReceiptText(state, null, 0, false, null, "on", true);
		// The status skill still opens the block, the Chinese reminder still
		// closes it, and the nudge sits between them.
		expect(armed.startsWith('<additional-system-instructions><skill version="1.0" enforced>')).toBe(true);
		expect(armed.endsWith("</skill></additional-system-instructions>")).toBe(true);
		expect(armed).toContain("Autopilot off");
		expect(armed.indexOf(nudgeText)).toBeGreaterThan(armed.indexOf("Autopilot off"));
		expect(armed.indexOf(nudgeText)).toBeLessThan(armed.indexOf("强制简体中文"));
		expect(armed.split("<skill version=").length - 1).toBe(3);
	});

	test("disarming removes the block and restores the quiet bytes", () => {
		const state = { autopilot: false };
		const armed = skillReceiptText(state, null, 0, false, null, "on", true);
		const disarmed = skillReceiptText(state, null, 0, false, null, "on", false);
		expect(disarmed).not.toContain(nudgeText);
		expect(disarmed).toBe(skillReceiptText(state));
	});

	test("the cached prefix never carries the nudge", () => {
		// The nudge rides the per-turn trailing block. Putting it in the system
		// prompt would make the provider re-prefill the whole conversation every
		// time a scope arms or disarms, so this assertion is the guard.
		const prompt = injectSystemPrompt("Host prompt.");
		expect(prompt).not.toContain(nudgeText);
		expect(prompt).not.toContain("Context pressure");
		expect(prompt).not.toContain('name="context-nudge"');
	});
});
