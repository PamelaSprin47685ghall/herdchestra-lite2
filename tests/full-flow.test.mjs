import { describe, expect, test } from "bun:test";
import { createRelay, copyRelay, isValidRelay } from "../src/relay/state.mjs";
import {
	applyLedgerEvaluation,
	beginGenerationAfterHandoff,
	invalidatePromotion,
} from "../src/relay/ledger.mjs";
import { relayStatusText } from "../src/relay/texts.mjs";

const WORK = [{ phase: "P", items: ["do it"] }];
const EMPTY = [];

function write(relay, phases, op = "init") {
	return applyLedgerEvaluation(relay, phases, { op, at: 1 });
}

describe("full flow switch", () => {
	test("starts simple and a non-empty ledger turns the full flow on", () => {
		const initial = createRelay();
		expect(initial.fullFlow).toBe(false);
		const opened = write(initial, WORK);
		expect(opened.relay.fullFlow).toBe(true);
		expect(opened.relay.firstEvaluation).toBe("nonempty");
	});

	test("an empty ledger also turns the full flow on and arms a handoff", () => {
		const armed = write(createRelay(), EMPTY);
		expect(armed.action).toBe("handoff");
		expect(armed.relay.fullFlow).toBe(true);
	});

	test("a handoff keeps the flow and the promoted successor ends it", () => {
		const armed = write(createRelay(), EMPTY).relay;
		const successor = beginGenerationAfterHandoff(armed, { at: 2 });
		expect(successor.fullFlow).toBe(true);
		const promoted = write(successor, EMPTY);
		expect(promoted.action).toBe("promoted");
		expect(promoted.relay.canStop).toBe(true);
		expect(promoted.relay.fullFlow).toBe(false);
	});

	test("a new ledger after promotion turns the flow on again", () => {
		const armed = write(createRelay(), EMPTY).relay;
		const successor = beginGenerationAfterHandoff(armed, { at: 2 });
		const promoted = write(successor, EMPTY).relay;
		const reopened = write(promoted, WORK);
		expect(reopened.relay.fullFlow).toBe(true);
	});

	test("a repeated empty write after promotion turns the flow back on", () => {
		const armed = write(createRelay(), EMPTY).relay;
		const successor = beginGenerationAfterHandoff(armed, { at: 2 });
		const promoted = write(successor, EMPTY);
		expect(promoted.action).toBe("promoted");
		expect(promoted.relay.fullFlow).toBe(false);
		const reopened = write(promoted.relay, EMPTY);
		expect(reopened.action).toBe("reopened");
		expect(reopened.relay.fullFlow).toBe(true);
		expect(reopened.relay.canStop).toBe(true);
		expect(reopened.relay.handoffPending).toBe(false);
		const text = relayStatusText(reopened.relay, reopened.stats, {
			action: reopened.action,
		});
		expect(text).toContain("Flow: full flow");
		expect(text).toContain("Can stop now: yes");
		expect(text).toContain("turns the full flow back on");
	});

	test("a second full cycle terminates after a reopened ledger", () => {
		// First cycle: an empty handoff, then the successor's first empty
		// evaluation promotes and returns the session to simple mode.
		const armed = write(createRelay(), EMPTY).relay;
		const successor = beginGenerationAfterHandoff(armed, { at: 2 });
		const promoted = write(successor, EMPTY).relay;

		// The promoted holder submits an empty ledger again, then opens a scope:
		// the promotion is invalidated and canStop is cleared.
		const reopened = write(promoted, EMPTY);
		expect(reopened.action).toBe("reopened");
		const held = invalidatePromotion(reopened.relay);
		expect(held.canStop).toBe(false);
		expect(held.promotionInvalidated).toBe(true);

		// Second cycle reuses the same branches: the empty write must arm a
		// handoff again, not be swallowed as another `reopened`.
		const secondArmed = write(held, EMPTY);
		expect(secondArmed.action).toBe("handoff");
		expect(secondArmed.relay.handoffPending).toBe(true);
		expect(secondArmed.relay.fullFlow).toBe(true);
		const secondSuccessor = beginGenerationAfterHandoff(secondArmed.relay, {
			at: 3,
		});
		expect(secondSuccessor.fullFlow).toBe(true);
		expect(secondSuccessor.firstEvaluation).toBe(null);

		// Its successor's first empty evaluation ends the chain again.
		const secondPromoted = write(secondSuccessor, EMPTY);
		expect(secondPromoted.action).toBe("promoted");
		expect(secondPromoted.relay.canStop).toBe(true);
		expect(secondPromoted.relay.fullFlow).toBe(false);
	});

	test("view and failed calls change nothing", () => {
		const view = applyLedgerEvaluation(createRelay(), WORK, { op: "view" });
		expect(view.relay.fullFlow).toBe(false);
		const failed = applyLedgerEvaluation(createRelay(), WORK, {
			op: "init",
			isError: true,
		});
		expect(failed.relay.fullFlow).toBe(false);
	});

	test("a snapshot without the switch is derived from the old fields", () => {
		const legacy = {
			generation: 0,
			firstEvaluation: "nonempty",
			canStop: false,
			handoffPending: false,
			promotionInvalidated: false,
			handoffError: null,
			lastLedger: null,
			lastHandoff: null,
		};
		expect(copyRelay(legacy).fullFlow).toBe(true);
		expect(isValidRelay(legacy)).toBe(true);
		expect(copyRelay({ ...legacy, canStop: true }).fullFlow).toBe(false);
	});

	test("status names the flow", () => {
		expect(relayStatusText(createRelay(), null, { action: null })).toContain(
			"Flow: simple",
		);
		expect(
			relayStatusText({ ...createRelay(), fullFlow: true }, null, {
				action: null,
			}),
		).toContain("Flow: full flow");
		const promoted = { ...createRelay(), generation: 2, canStop: true };
		expect(relayStatusText(promoted, null, { action: null })).toContain(
			"Flow: simple",
		);
		expect(relayStatusText(promoted, null, { action: null })).not.toContain(
			"no ledger",
		);
	});
});
