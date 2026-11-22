// Nudge decision: which steer, if any, this assistant message earns.
// Pure; the station performs the delivery.

import { unreceivedChildren } from "../scope/index.mjs";
import { insideScopeNudge } from "./texts.mjs";

/**
 * The join nudge outranks every other process nudge.
 *
 * An unreceived child may be parked inside `scope_return`, waiting for the
 * take that releases it. No relay, handoff, or successor rule can release
 * that child, so a turn that ends with one outstanding earns exactly one
 * steer: `scope_join`. The root obeys this too; a natural stop there is the
 * easiest place to forget the receive obligation.
 *
 * @returns {{ kind: "none" } | { kind: "steer", text: string }}
 */
export function nudgeDecision({ hasToolCalls, ledger = null, ownerId = null }) {
	if (hasToolCalls) return { kind: "none" };
	const open = ledger ? unreceivedChildren(ledger, ownerId ?? "root").length : 0;
	if (open > 0) return { kind: "steer", text: insideScopeNudge(open) };
	return { kind: "none" };
}
