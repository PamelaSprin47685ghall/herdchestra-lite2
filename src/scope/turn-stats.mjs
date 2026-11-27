// Sufficient statistics for one LLM request's wall time.
//
// Lifetime totals (turnMs/turns) are persisted with the ledger. Time
// estimates must not use them: samples live in memory for this session only,
// keyed by ledger identity, and are grouped by model. A restored ledger is a
// new object, so a reload starts with no samples; another model's samples are
// never borrowed.

export const DEFAULT_TURN_MS = 60000;

/** Rolling window of recent request durations per session and model. */
export const SAMPLE_LIMIT = 20;

/** One slow request must not inflate every later time estimate. */
export const MAX_SAMPLE_MS = 120000;

/** A sub-second sample says nothing useful about request cost. */
export const MIN_SAMPLE_MS = 1000;

/** ledger object -> { byModel: Map<string, number[]>, lastModel: string } */
const SESSION_SAMPLES = new WeakMap();

function samplesOf(ledger) {
	let store = SESSION_SAMPLES.get(ledger);
	if (!store) {
		store = { byModel: new Map(), lastModel: "" };
		SESSION_SAMPLES.set(ledger, store);
	}
	return store;
}

export function emptyTotals() {
	return { turnMs: 0, turns: 0 };
}

/**
 * Clamp one request duration into the range a time estimate may use. The
 * lifetime totals keep the raw span; only the rolling window is bounded.
 */
export function clampSampleMs(value) {
	if (!Number.isFinite(value) || value < MIN_SAMPLE_MS) return null;
	return Math.min(MAX_SAMPLE_MS, value);
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

/**
 * Record one finished request for this session and model. The ledger object
 * is shared by every scope in the session, so their samples merge; a restored
 * ledger is a different object and therefore starts empty.
 */
export function recordTurnSample(ledger, modelKey, durationMs) {
	if (!ledger || typeof ledger !== "object") return false;
	if (typeof modelKey !== "string" || modelKey === "") return false;
	const sample = clampSampleMs(durationMs);
	if (sample == null) return false;
	const store = samplesOf(ledger);
	const samples = store.byModel.get(modelKey) ?? [];
	samples.push(sample);
	if (samples.length > SAMPLE_LIMIT) {
		samples.splice(0, samples.length - SAMPLE_LIMIT);
	}
	store.byModel.set(modelKey, samples);
	store.lastModel = modelKey;
	return true;
}

/** Samples recorded in this session for one model; never another model's. */
export function modelSamples(ledger, modelKey) {
	if (!ledger || typeof ledger !== "object") return [];
	if (typeof modelKey !== "string" || modelKey === "") return [];
	const store = samplesOf(ledger);
	return store.byModel.get(modelKey) ?? [];
}

/** Mean of one sample array, or null when it holds no usable number. */
export function recentAverageTurnMs(samples) {
	if (!Array.isArray(samples)) return null;
	let sum = 0;
	let count = 0;
	for (const value of samples) {
		if (typeof value === "number" && Number.isFinite(value)) {
			sum += value;
			count += 1;
		}
	}
	return count > 0 ? sum / count : null;
}

/** Sum the fork item's own enumerable turns. Inherited keys do not count. */
export function sumTurns(turns) {
	if (!turns || typeof turns !== "object") return 0;
	let sum = 0;
	for (const key of Object.keys(turns)) {
		if (typeof key !== "string") continue;
		const value = turns[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			sum += value;
		}
	}
	return sum;
}

/**
 * Seconds for one fork: mean of this session's and this model's recent
 * samples times its turns, at least one second. No usable sample
 * falls back to one minute per turn; another session or another model is
 * never used as a substitute.
 */
export function deriveTimeBudgetSeconds({
	samples,
	budget,
	fallbackMs = DEFAULT_TURN_MS,
} = {}) {
	const turns = Math.max(1, sumTurns(budget));
	const measured = recentAverageTurnMs(samples);
	const avg =
		measured == null
			? finiteNonNegative(fallbackMs) || DEFAULT_TURN_MS
			: measured;
	return Math.max(1, Math.round((avg / 1000) * turns));
}
