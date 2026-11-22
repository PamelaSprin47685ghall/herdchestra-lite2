// Pure handoff/relay decisions for the Station.
//
// The Station and handoff-state own persistence, compaction, registry marks,
// prompt delivery and diagnostics. This module owns only the decision over a
// plain relay snapshot. It never imports the Station or a host module, never
// mutates its inputs, and returns either a decision or a refusal.

import {
	applyLedgerEvaluation,
	applyRetirement,
	beginGenerationAfterHandoff,
	ledgerStats,
} from "../../relay/index.mjs";

const NO_LEDGER_STATS = Object.freeze({ empty: true, open: 0, total: 0 });

/**
 * Decide what one ledger write means for the relay.
 *
 * `none` owes nothing, so it keeps the shared answer shape without touching
 * the relay. An empty ledger is a claim that nothing remains; while this root
 * still owns an unreceived child, that claim is false: the write is accepted
 * and reported as held, but the relay does not advance.
 */
export function decideRelayEvaluation({
	relay,
	owesLedger,
	phases,
	op,
	options = {},
	unreceived = 0,
} = {}) {
	if (!owesLedger) {
		return {
			relay,
			stats: NO_LEDGER_STATS,
			action: null,
			changed: false,
			commit: false,
		};
	}
	const stats = ledgerStats(phases);
	if (options.isError !== true && op !== "view" && stats.empty && unreceived > 0) {
		return {
			relay,
			stats,
			action: "held",
			changed: false,
			unreceived,
			commit: false,
		};
	}
	return {
		...applyLedgerEvaluation(relay, phases, { op, ...options }),
		commit: true,
	};
}

/** A non-empty ledger at a natural stop is a retirement, not a violation. */
export function decideRetirement({ relay, owesLedger } = {}) {
	if (!owesLedger) return null;
	return applyRetirement(relay);
}

/** Only the handoff degree may arm a transfer, and only on a stoppable relay. */
export function decideHandoffArm({ relay, isChild, canHandoff } = {}) {
	if (isChild || !canHandoff) return { arm: false };
	if (!relay || relay.canStop) return { arm: false };
	return {
		arm: true,
		relay: { ...relay, handoffPending: true },
	};
}

/** Advance one generation after a committed handoff. */
export function decideHandoffAdvance({
	relay,
	isChild,
	canHandoff,
	expectedGeneration,
	at,
} = {}) {
	if (isChild || !canHandoff) return { advance: false };
	if (!relay || !relay.handoffPending || relay.canStop) {
		return { advance: false };
	}
	if (
		Number.isInteger(expectedGeneration) &&
		expectedGeneration !== relay.generation
	) {
		return { advance: false };
	}
	return {
		advance: true,
		relay: beginGenerationAfterHandoff(relay, {
			at,
			fromGeneration: relay.generation,
		}),
	};
}

/**
 * A natural stop is a submission: a non-empty ledger retires, an empty one
 * evaluates. Children, manual stops, and already-ending relays have no plan.
 */
export function decideNaturalStop({
	relay,
	isChild,
	autopilot,
	owesLedger,
	unreceived = 0,
} = {}) {
	if (!owesLedger || !autopilot || isChild) return null;
	// No natural-stop submission may count before every child is received.
	// The equivalent empty ledger is withheld for the same reason: the root
	// still owes a take, and the child parked in scope_return cannot move
	// until that take happens. The join nudge owns this turn instead.
	if (unreceived > 0) return null;
	if (!relay || relay.handoffPending || relay.canStop) return null;
	const beforeFirstEvaluation =
		relay.generation > 0 && relay.firstEvaluation === null;
	const retired =
		!beforeFirstEvaluation && relay.lastLedger?.empty === false;
	return { kind: retired ? "retire" : "evaluate" };
}

/** Clear the inherited-ledger requirement once the successor has looked. */
export function decideInheritedLedgerViewed({ relay } = {}) {
	if (!relay?.viewRequired) return null;
	return { relay: { ...relay, viewRequired: false } };
}

/** A non-empty report is captured only while a handoff is pending. */
export function decideHandoffReport({ relay, isChild, text } = {}) {
	if (isChild || !relay?.handoffPending) return { capture: false };
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (!trimmed) return { capture: false };
	return { capture: true, text: trimmed };
}

/** A self-handoff is legal only on a pending, stoppable relay. */
export function decideSelfHandoff({ relay, isChild } = {}) {
	if (isChild) return false;
	if (!relay || !relay.handoffPending || relay.canStop) return false;
	return true;
}
