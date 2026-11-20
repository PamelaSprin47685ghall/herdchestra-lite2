// Nudge decision: which steer, if any, this assistant message earns.
// Pure; the station performs the delivery and the handoff arming.

import { currentScope } from "../scope/index.mjs";
import {
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
	// be followed by the final answer.
	if (relay.fullFlow !== true) return { kind: "none" };
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
