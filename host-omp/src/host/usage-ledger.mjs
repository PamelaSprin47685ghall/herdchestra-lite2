/**
 * Usage ledger decisions: the two rules the status runtime used to decide inline.
 *
 * The runtime still owns the session records, the widget, and the events. These
 * two questions are about the ledger rather than about rendering, so they live
 * here and can be answered without a host:
 *
 *   - what the whole session tree spent  (Σ over every record's totals)
 *   - whether a start begins a new ledger (a new root, not a forked child)
 *
 * Pure: the only input beyond the totals map is the agent's parent mark, and
 * neither function writes anything.
 */
import { accumulateUsage, zeroUsage } from "./usage.mjs";

/**
 * The whole session tree's running total.
 *
 * Σ is not one manager's spend: a root, its fork branches, and any child session
 * that shares the tree all draw on one budget, so the line reports what the tree
 * spent. A genuinely new root starts a fresh ledger and clears the map, so
 * nothing older leaks in.
 */
export function totalUsage(totals) {
	const total = zeroUsage();
	for (const snapshot of totals.values()) accumulateUsage(total, snapshot);
	return total;
}

/**
 * True when a `session_start` begins a genuinely new ledger.
 *
 * A second start on the same manager must keep the accumulated totals: the
 * session, not the flow, owns them. Only a new root clears them; a forked child
 * carries its parent's mark and shares the parent's budget.
 */
export function startsNewLedger(created, ctx) {
	return created && !ctx?.agent?.parentId;
}
