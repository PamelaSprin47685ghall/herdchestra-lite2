// Nudge decision: which steer, if any, this assistant message earns.
// Pure; the station performs the delivery.

import { unreceivedChildren } from "../scope/index.mjs";
import { insideScopeNudge } from "./texts.mjs";

/**
 * @returns {{ kind: "none" } | { kind: "steer", text: string }}
 */
export function nudgeDecision(state, { hasToolCalls, ledger = null, ownerId = null }) {
	if (!state.autopilot || hasToolCalls) return { kind: "none" };
	// A branch that still owns unreceived work is the one thing a stop cannot
	// do silently: a returned result no join has taken is as unreceived as a
	// running child. At the root a stop is a submission, so no steer may judge
	// it here.
	const open = ledger && typeof unreceivedChildren === "function"
		? unreceivedChildren(ledger, ownerId ?? "root").length
		: 0;
	if (open > 0) {
		return { kind: "steer", text: insideScopeNudge(open) };
	}
	return { kind: "none" };
}
