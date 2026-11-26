// Context-occupancy nudge: has this scope grown past its window midpoint?
//
// Pure arithmetic, no I/O, no state. The station owns the scope and the usage
// ledger owns the measured facts; this module answers one question about the
// three numbers they already hold, so the boundary can be tested alone.
//
// Baseline is the occupancy this scope's first measured request carried, and
// the window is the model's input limit. The midpoint of that interval is the
// point where every further turn spends the scope's remaining headroom at
// twice the price of the turns before it: half the room is gone, and the half
// that is left has to cover the handoff as well as the work.

/**
 * The midpoint between a scope's birth occupancy and its input limit.
 *
 * `(window - baseline) / 2 + baseline`, the arithmetic the contract states.
 *
 * Returns `null` for every case with no midpoint to name: an unknown window,
 * an unmeasured baseline, or a window at or below the baseline (a scope born
 * already at its limit has no interval to halve). Those cases are `null`, not
 * `Infinity` and not a guess — `contextNudgeArmed` reads the last of them as
 * "no room left, arm at once", and the first two as "no measurement, stay
 * quiet".
 */
export function contextMidpoint({ baseline, window: windowTokens } = {}) {
	if (!Number.isFinite(baseline) || baseline < 0) return null;
	if (!Number.isFinite(windowTokens) || windowTokens <= 0) return null;
	if (windowTokens <= baseline) return null;
	return (windowTokens - baseline) / 2 + baseline;
}

/**
 * Should the *next* request carry the return nudge?
 *
 * The boundary is strict: `occupancy > midpoint`. Equality means the scope
 * sits exactly halfway between its birth and its limit, where continuing
 * still pays; the nudge begins one token later. That keeps a scope that
 * never grows past its own midpoint from hearing the same sentence forever.
 *
 * A window at or below the baseline arms at once, because the scope has no
 * room left to grow into and waiting for a midpoint that does not exist would
 * never fire. Any unknown input refuses to arm: an unmeasured occupancy, an
 * unmeasured baseline, or an unknown window must never produce a nudge, and
 * the guards also keep the division from running on a value that is not a
 * number.
 *
 * One arithmetic, one caller: the guards run first, so a `null` midpoint can
 * only mean a window at or below the baseline, and every other verdict is the
 * comparison against the same expression `contextMidpoint` owns.
 */
export function contextNudgeArmed({ occupancy, baseline, window: windowTokens } = {}) {
	if (!Number.isFinite(windowTokens) || windowTokens <= 0) return false;
	if (!Number.isFinite(baseline) || baseline < 0) return false;
	if (!Number.isFinite(occupancy) || occupancy < 0) return false;
	const midpoint = contextMidpoint({ baseline, window: windowTokens });
	if (midpoint === null) return true;
	return occupancy > midpoint;
}
