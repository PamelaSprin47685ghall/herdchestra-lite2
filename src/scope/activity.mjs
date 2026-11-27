// The status row: one string, computed from the fork ledger.
//
// It holds no host objects, does no I/O, and never touches a session: the host
// renders the line this returns.

import { forkOf, RUNNING, READY } from "./forkjoin.mjs";
import { publicScopeId, scopeTitle } from "./scope-id.mjs";

export function scopeActivity(ledger, lastOwnerId, rootBusy, clock = null) {
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
	return `[Busy: ${busy}, Idle: ${idle}]${lineage.length ? ` ${lineage.join(" > ")}` : ""}`;
}
