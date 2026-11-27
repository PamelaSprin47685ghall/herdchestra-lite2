// The status row: one string, computed from the fork ledger.
//
// It holds no host objects, does no I/O, and never touches a session: the host
// renders the line this returns.

import { forkOf } from "./ledger-charge.mjs";
import { READY, RUNNING } from "./ledger-brackets.mjs";
import { publicScopeId, scopeTitle } from "./scope-id.mjs";

export function scopeActivity(ledger, lastOwnerId, rootBusy, clock = null, goal = false) {
	let busy = Number(rootBusy);
	let idle = Number(!rootBusy);
	for (const id of ledger.order) {
		const branch = forkOf(ledger, id);
		if (!branch) continue;
		const paused = branch?.clockPausedAt != null &&
			(!clock || clock.info(branch).bounded !== false);
		if (branch?.status === RUNNING && !paused) busy++;
		else if (branch?.status === READY || branch?.status === RUNNING) idle++;
	}
	const lineage = [];
	const seen = new Set();
	for (let id = lastOwnerId; id && id !== "root" && !seen.has(id);) {
		seen.add(id);
		const branch = forkOf(ledger, id);
		if (!branch) break;
		lineage.push(scopeTitle(publicScopeId(branch)));
		id = branch.ownerId;
	}
	lineage.reverse();
	const counts = goal === true
		? `[Busy: ${busy}, Idle: ${idle}, Goal: ON]`
		: `[Busy: ${busy}, Idle: ${idle}]`;
	return `${counts}${lineage.length ? ` ${lineage.join(" > ")}` : ""}`;
}
