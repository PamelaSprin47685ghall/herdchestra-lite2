// Nudge decision: which steer, if any, this assistant message earns.
// Pure; the station performs the delivery and spends the allowance.

import { forkOf, RUNNING, unreceivedChildren } from "../scope/index.mjs";
import {
	childReturnNudge,
	MAX_RETURN_NUDGES,
	returnNudgesOf,
} from "../scope/return-nudge.mjs";
import { insideScopeNudge, rootReturnNudge } from "./texts.mjs";

/**
 * Two obligations earn a steer, in this order.
 *
 * 1. `scope_join` outranks every other process nudge. An unreceived child
 *    (running or ready) must be joined before stopping — at Root (even with
 *    autopilot off) and in any child scope.
 *
 * 2. Active scopes must exit through `scope_return`, not a silent natural stop:
 *    - Child scope (`ownerId !== null`): while its bracket is `RUNNING` and its
 *      shared return-nudge allowance has room, steer it to call `scope_return`.
 *    - Root scope (`ownerId === null`): when `autopilot` is on and
 *      `canStop !== true` (and no Root rewind is already pending), steer it to
 *      call `scope_return` (omit the oath to rewind and keep working; include
 *      the oath when truly done).
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
	autopilot = false,
	relay = null,
} = {}) {
	if (hasToolCalls) return { kind: "none" };
	const open = ledger ? unreceivedChildren(ledger, ownerId ?? "root").length : 0;
	if (open > 0) return { kind: "steer", text: insideScopeNudge(open) };
	if (ownerId !== null) {
		if (!ledger) return { kind: "none" };
		const record = forkOf(ledger, ownerId);
		if (!record || record.status !== RUNNING) return { kind: "none" };
		if (returnNudgesOf(record) >= MAX_RETURN_NUDGES) return { kind: "none" };
		return { kind: "steer", text: childReturnNudge(), charge: "return" };
	}
	if (autopilot === true && relay?.canStop !== true && !relay?.pendingRewind) {
		return { kind: "steer", text: rootReturnNudge() };
	}
	return { kind: "none" };
}
