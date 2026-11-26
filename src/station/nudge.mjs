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
 * 1. A hard mode names the one move that remains: `AWAITING_REPLY` needs
 *    `scope_reply`, `CONTEXT_LIMIT` needs `scope_return`. `FINAL_ANSWER` never
 *    steers — the only move left is the final answer itself.
 * 2. Unreceived children outrank every other process nudge.
 * 3. A running child scope must exit through `scope_return` while its shared
 *    return-nudge allowance has room.
 * 4. Root under autopilot must call `scope_return` until `canStop` is true.
 *
 * The decision does not charge the allowance itself. A steer the host refuses
 * to accept was never delivered, so it must not cost the child a retry; the
 * caller charges only after delivery succeeds.
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
	from = null,
} = {}) {
	if (hasToolCalls) return { kind: "none" };
	if (mode === "FINAL_ANSWER") return { kind: "none" };
	if (mode === "AWAITING_REPLY" || mode === "CONTEXT_LIMIT") {
		return { kind: "steer", text: stopNudge(mode, { unreceived, from }) };
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
