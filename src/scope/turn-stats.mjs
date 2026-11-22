// Sufficient statistics for one LLM request's wall time.
//
// One turn is one provider request. The ledger stores only the two numbers
// that determine the mean: summed request duration and request count. k
// concurrent scopes write the same totals, so concurrent time counts k times
// and concurrent requests each count. In-flight clocks are not persisted.

export const DEFAULT_TURN_MS = 60000;

export function emptyTotals() {
	return { turnMs: 0, turns: 0 };
}

function finiteNonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

export function normalizeTotals(value) {
	return {
		turnMs: finiteNonNegative(value?.turnMs),
		turns: finiteNonNegative(value?.turns),
	};
}

export function createTurnClock() {
	return { startedAt: null };
}

/** Open a request window only when none is already open. */
export function beginRequest(clock, now) {
	if (!clock || typeof clock !== "object") return false;
	if (clock.startedAt != null) return false;
	if (!Number.isFinite(now)) return false;
	clock.startedAt = now;
	return true;
}

/**
 * Close one open request into the shared totals. A double delivery, a missing
 * window, or a clock that ran backwards leaves the totals alone.
 */
export function finishRequest(clock, totals, now) {
	if (!clock || !Number.isFinite(clock.startedAt)) return null;
	if (!Number.isFinite(now) || now < clock.startedAt) return null;
	if (!totals || typeof totals !== "object") return null;
	const delta = now - clock.startedAt;
	totals.turnMs = finiteNonNegative(totals.turnMs) + delta;
	totals.turns = finiteNonNegative(totals.turns) + 1;
	clock.startedAt = null;
	return delta;
}

/** Drop an in-flight request. The abandoned span is not a sample. */
export function abandonRequest(clock) {
	if (!clock || typeof clock !== "object") return false;
	clock.startedAt = null;
	return true;
}

export function averageTurnMs(totals) {
	const turns = totals?.turns;
	const turnMs = totals?.turnMs;
	if (!Number.isFinite(turns) || turns <= 0) return null;
	if (!Number.isFinite(turnMs) || turnMs < 0) return null;
	return turnMs / turns;
}

/** Sum the fork item's own enumerable budget points. Inherited keys do not count. */
export function sumBudgetPoints(budget) {
	if (!budget || typeof budget !== "object") return 0;
	let sum = 0;
	for (const key of Object.keys(budget)) {
		if (typeof key !== "string") continue;
		const value = budget[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			sum += value;
		}
	}
	return sum;
}

/**
 * Seconds for one fork: mean request time times its budget points, at least
 * one second. No samples fall back to one minute times the points.
 */
export function deriveTimeBudgetSeconds({
	totals,
	budget,
	fallbackMs = DEFAULT_TURN_MS,
} = {}) {
	const points = sumBudgetPoints(budget);
	const measured = averageTurnMs(totals);
	const avg =
		measured == null
			? finiteNonNegative(fallbackMs) || DEFAULT_TURN_MS
			: measured;
	return Math.max(1, Math.round((avg / 1000) * points));
}
