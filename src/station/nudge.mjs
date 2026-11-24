// Nudge decision: which steer, if any, this assistant message earns.
// Pure; the station performs the delivery and spends the allowance.

import { forkOf, RUNNING, unreceivedChildren } from "../scope/index.mjs";
import {
	childReturnNudge,
	MAX_RETURN_NUDGES,
	returnNudgesOf,
} from "../scope/return-nudge.mjs";
import { insideScopeNudge } from "./texts.mjs";

/**
 * Two obligations earn a steer, in this order.
 *
 * `scope_join` outranks every other process nudge. An unreceived child may be
 * parked inside `scope_return`, waiting for the take that releases it. No
 * relay, handoff, or successor rule can release that child, so a turn that
 * ends with one outstanding earns exactly one steer: `scope_join`. The root
 * obeys this too; a natural stop there is the easiest place to forget the
 * receive obligation.
 *
 * A forked scope owes its record, and a natural stop submits nothing. A child
 * that ends a turn without tool calls while its own bracket is still running
 * is told to call `scope_return`. This is the in-turn leg; the session-stop
 * gate is the other leg, and both spend the record's one return allowance.
 * The ticket owns the bound's consequence: after `MAX_RETURN_NUDGES` it closes
 * the bracket as failed, and a failed record is no longer running, so this
 * rule turns itself off.
 *
 * The decision does not charge the allowance itself. A steer the host refuses
 * to accept was never delivered, so it must not cost the child a retry; the
 * caller charges only after delivery succeeds.
 *
 * @returns {{ kind: "none" } | { kind: "steer", text: string, charge?: "return" }}
 */
export function nudgeDecision({ hasToolCalls, ledger = null, ownerId = null }) {
	if (hasToolCalls) return { kind: "none" };
	const open = ledger ? unreceivedChildren(ledger, ownerId ?? "root").length : 0;
	if (open > 0) return { kind: "steer", text: insideScopeNudge(open) };
	if (!ledger || ownerId === null) return { kind: "none" };
	const record = forkOf(ledger, ownerId);
	if (!record || record.status !== RUNNING) return { kind: "none" };
	if (returnNudgesOf(record) >= MAX_RETURN_NUDGES) return { kind: "none" };
	return { kind: "steer", text: childReturnNudge(), charge: "return" };
}
