// Nudge decision: which steer, if any, this assistant message earns.
// Pure; the station performs the delivery and spends the allowance.

import { forkOf, RUNNING, unreceivedChildren } from "../scope/index.mjs";
import {
	childReturnNudge,
	MAX_RETURN_NUDGES,
	returnNudgesOf,
} from "../scope/return-nudge.mjs";
import { insideScopeNudge, rootReturnNudge, stopNudge } from "./texts.mjs";

/**
 * The steer this assistant message earns, in priority order.
 *
 * 1. `FINAL_ANSWER` never steers.
 * 2. `ABANDONED` outranks `CONTEXT_LIMIT` and `unreceived`; charges the
 *    shared return-nudge allowance so a stuck abandoned scope still terminates.
 * 3. `CONTEXT_LIMIT` needs `scope_return`.
 * 4. Unreceived subscopes outrank normal return nudges.
 * 5. A running subscope must exit through `scope_return` while its shared
 *    return-nudge allowance has room.
 * 6. Root inside a goal session must call `scope_return` until `canStop` is true.
 *
 * @returns {{ kind: "none" } | { kind: "steer", text: string, charge?: "return" }}
 */
export function nudgeDecision({
	hasToolCalls,
	ledger = null,
	ownerId = null,
	mode = null,
	unreceived = 0,
	relay = null,
	abandoned = null,
} = {}) {
	if (hasToolCalls) return { kind: "none" };
	if (mode === "FINAL_ANSWER") return { kind: "none" };
	if (mode === "ABANDONED") {
		if (ownerId !== null && ledger) {
			const record = forkOf(ledger, ownerId);
			if (!record || record.status !== RUNNING) return { kind: "none" };
			if (returnNudgesOf(record) >= MAX_RETURN_NUDGES) return { kind: "none" };
			return {
				kind: "steer",
				text: stopNudge("ABANDONED", { abandoned }),
				charge: "return",
			};
		}
		return { kind: "steer", text: stopNudge("ABANDONED", { abandoned }) };
	}
	if (mode === "CONTEXT_LIMIT") {
		return { kind: "steer", text: stopNudge(mode, { unreceived }) };
	}
	const open =
		unreceived > 0
			? unreceived
			: ledger
				? unreceivedChildren(ledger, ownerId ?? "root").length
				: 0;
	if (open > 0) return { kind: "steer", text: insideScopeNudge(open) };
	if (ownerId !== null) {
		if (!ledger) return { kind: "none" };
		const record = forkOf(ledger, ownerId);
		if (!record || record.status !== RUNNING) return { kind: "none" };
		if (returnNudgesOf(record) >= MAX_RETURN_NUDGES) return { kind: "none" };
		return { kind: "steer", text: childReturnNudge(), charge: "return" };
	}
	if (mode === "ROOT_AUTOPILOT" && relay?.canStop !== true && !relay?.pendingRewind) {
		return { kind: "steer", text: rootReturnNudge() };
	}
	return { kind: "none" };
}
