// Nudge decision: which steer, if any, this assistant message earns.
// Pure; the station performs the delivery and the handoff arming.

import { currentScope } from "../scope/index.mjs";
import {
	copyRelay,
	firstEvaluationNudge,
	handoffEmptyReportNudge,
	openLedgerNudge,
} from "../relay/index.mjs";
import { insideScopeNudge } from "./texts.mjs";

/**
 * @returns {{ kind: "none" }
 *   | { kind: "steer", text: string }
 *   | { kind: "handoff", text: string }}
 */
export function nudgeDecision(state, { hasToolCalls, hasHandoffReport }) {
	if (state.herdMode || hasToolCalls) return { kind: "none" };
	if (currentScope(state)) {
		return { kind: "steer", text: insideScopeNudge(state) };
	}
	const relay = state.relay;
	if (!relay) return { kind: "steer", text: firstEvaluationNudge() };
	// Outside the full flow there is no ledger obligation: a finished scope may
	// be followed by the final answer. Two cases still owe one, and both used to
	// go silent here:
	//
	// 1. A legacy snapshot omits `fullFlow`. Every other reader derives it
	//    through `copyRelay`, so this reader must too; otherwise a restored
	//    full-flow line stops being nudged at all.
	// 2. A ledger is still on record. The obligation belongs to the ledger, not
	//    to the switch: a non-empty ledger forbids a silent stop wherever the
	//    holder stands.
	const current = copyRelay(relay);
	if (current.fullFlow !== true) {
		// A holder that was already allowed to stop owes nothing, even when a
		// stale ledger survived the promotion.
		if (current.canStop) return { kind: "none" };
		const ledger = current.lastLedger;
		if (ledger && ledger.empty === false) {
			return { kind: "steer", text: openLedgerNudge(current, ledger) };
		}
		return { kind: "none" };
	}
	return nextOutsideScopeNudge(current, hasHandoffReport);
}

/**
 * The outside-scope decision once the relay is known to be in the full flow.
 *
 * Split out so the legacy and ledger fallbacks above ask the same questions
 * instead of repeating them, and drifting from the answers.
 */
function nextOutsideScopeNudge(relay, hasHandoffReport) {
	if (relay.canStop) return { kind: "none" };
	if (relay.handoffPending) {
		return hasHandoffReport
			? { kind: "none" }
			: { kind: "steer", text: handoffEmptyReportNudge() };
	}
	if (!relay.lastLedger) {
		return { kind: "steer", text: firstEvaluationNudge() };
	}
	// After a handoff, lastLedger still holds the previous holder's empty
	// snapshot. The successor has not evaluated yet, so do not hand off again;
	// require its first todo evaluation first.
	if (relay.generation > 0 && relay.firstEvaluation === null) {
		return { kind: "steer", text: firstEvaluationNudge() };
	}
	if (relay.lastLedger.empty) {
		return { kind: "handoff", text: handoffEmptyReportNudge() };
	}
	return { kind: "steer", text: openLedgerNudge(relay, relay.lastLedger) };
}
