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
import {
	projectCapabilities,
	renderConsoleReceipt,
} from "../src/station/domain/capabilities.mjs";
import { probeOf } from "./helpers/probe-view.mjs";

const nudgeSteer = loadDoc("receipts/scope")["mode.context-limit"];

// The probe body is parsed by tests/helpers/probe-view.mjs.

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

	test("crossing the midpoint arms the next request", () => {
		const ledger = ledgerWith(10000);
		response(ledger, 1000);
		expect(ledger.contextNudge).toBe(false);
		response(ledger, 5400);
		// 5400 + 100 output = 5500, exactly the midpoint: still not armed.
		expect(ledger.contextNudge).toBe(false);
		response(ledger, 5401);
		expect(ledger.contextNudge).toBe(true);
		// The only remaining disarm is a new birth (a rewind or a reborn
		// scope); the fold that used to reclaim room mid-scope is gone, and
		// `resetWatermark` is pinned by the next case.
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
	const quietFacts = {
		isChild: false,
		autopilot: false,
		canStop: false,
		unreceived: 0,
		activePaths: ["/"],
	};

	test("past the midpoint the tools collapse to one, and nothing moves into the prompt", () => {
		const quiet = renderConsoleReceipt(projectCapabilities(quietFacts));
		expect(quiet).toContain("scope_request");
		// The signal is a hard mode, not a paragraph: the whole api disappears.
		const armed = projectCapabilities({ ...quietFacts, contextOverHalf: true });
		expect(armed.mode).toBe("CONTEXT_LIMIT");
		expect(probeOf(renderConsoleReceipt(armed)).api).toEqual(["scope_return"]);
	});

	test("the collapsed probe keeps the state the model still needs", () => {
		const view = probeOf(
			renderConsoleReceipt(
				projectCapabilities({
					...quietFacts,
					contextOverHalf: true,
					unreceived: 2,
					activePaths: ["/", "/api"],
				}),
			),
		);
		expect(view.api).toEqual(["scope_return"]);
		expect(view.mode).toBe("CONTEXT_LIMIT");
		// The address book and the pending count survive the collapse.
		expect(view.unreceived).toBe(2);
		expect(view.scopes).toEqual(["/", "/api"]);
	});

	test("disarming restores the quiet bytes", () => {
		const armed = renderConsoleReceipt(
			projectCapabilities({ ...quietFacts, contextOverHalf: true }),
		);
		const quiet = renderConsoleReceipt(projectCapabilities({ ...quietFacts }));
		expect(quiet).not.toContain("CONTEXT_LIMIT");
		expect(quiet).toContain("scope_request");
		expect(quiet).toBe(renderConsoleReceipt(projectCapabilities({ ...quietFacts })));
		expect(armed).not.toBe(quiet);
	});

	test("the cached prefix never carries a per-turn steer", () => {
		// The armed signal is a hard mode printed by the trailing probe, so the
		// steer must stay out of the prefix; putting it there would force a full
		// re-prefill every time a scope armed or disarmed.
		const prompt = injectSystemPrompt("Host prompt.");
		expect(prompt).not.toContain(nudgeSteer);
		expect(prompt).not.toContain("Context Pressure");
	});
});
