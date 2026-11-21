// Context-bloat cognitive degradation (empirical linear model).
//
// Effective work progressed per turn declines linearly from 1 at an empty
// context to 1/2 at a full context window:
//
//   eta(C, W) = 1 - 0.5 * clamp(C / W, 0, 1)
//
// A bigger context therefore does not only cost more per read: it stretches
// the same work over more turns, and every extra turn pays the full context
// re-read, a fresh output, and another cache write. This module turns that
// observation into pure arithmetic. No I/O, no state.

export const FULL_CONTEXT_EFFICIENCY = 0.5;

const DEGRADATION_SLOPE = 1 - FULL_CONTEXT_EFFICIENCY;

function finiteNonNegative(value) {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function usableWindow(contextWindow) {
	return Number.isFinite(contextWindow) && contextWindow > 0
		? contextWindow
		: null;
}

function usableContext(contextTokens) {
	return Number.isFinite(contextTokens) && contextTokens > 0
		? contextTokens
		: null;
}

/** Effective work progressed per turn in [0.5, 1]. Returns 1 if unknown. */
export function contextEfficiency(contextTokens, contextWindow) {
	const window = usableWindow(contextWindow);
	const context = usableContext(contextTokens);
	if (window === null || context === null) return 1;
	const utilization = Math.min(1, Math.max(0, context / window));
	return 1 - DEGRADATION_SLOPE * utilization;
}

/**
 * Per-turn cost that does not shrink with the cached prefix: the model's own
 * output (thinking included) plus the dialogue delta this turn appends to the
 * cache, priced at the miss rate when written.
 */
export function turnOverheadCost({
	pMiss = 0,
	pOut = 0,
	outputTokens = 0,
	turnGrowthTokens = 0,
} = {}) {
	return (
		finiteNonNegative(outputTokens) * finiteNonNegative(pOut) +
		finiteNonNegative(turnGrowthTokens) * finiteNonNegative(pMiss)
	);
}

/**
 * Exact counterfactual economic rent wasted on one actual turn by keeping a
 * foldable pool of size B at context C in window W:
 *
 *   rent = K(C) - (etaKeep / etaFold) * K(C - B)
 *        = B * pHit + ((etaFold - etaKeep) / etaFold) * ((C - B) * pHit + K_non)
 *
 * `K_non` is the part of a turn that does not shrink with the cached prefix.
 * Reduces identically to `B * pHit` when W or C is unknown.
 */
export function poolTurnRent({
	poolTokens,
	contextTokens,
	contextWindow,
	pHit,
	nonContextTurnCost = 0,
}) {
	const pool = finiteNonNegative(poolTokens);
	const hit = finiteNonNegative(pHit);
	if (pool <= 0) {
		return { total: 0, direct: 0, degradation: 0, etaKeep: 1, etaFold: 1 };
	}
	const direct = pool * hit;
	const window = usableWindow(contextWindow);
	const context = usableContext(contextTokens);
	if (window === null || context === null) {
		return { total: direct, direct, degradation: 0, etaKeep: 1, etaFold: 1 };
	}
	// A measured context smaller than the pool it contains is noise, not
	// information. Clamp the fold result at zero so the direct rent survives.
	const keepContext = Math.max(context, pool);
	const foldContext = keepContext - pool;
	const etaKeep = contextEfficiency(keepContext, window);
	const etaFold = contextEfficiency(foldContext, window);
	const nonContext = finiteNonNegative(nonContextTurnCost);
	const foldTurnCost = foldContext * hit + nonContext;
	const degradation =
		etaFold > etaKeep
			? ((etaFold - etaKeep) / etaFold) * foldTurnCost
			: 0;
	return {
		total: direct + degradation,
		direct,
		degradation,
		etaKeep,
		etaFold,
	};
}

/**
 * Future savings over `nominalWork` empty-context turns from folding
 * `poolTokens`, of which `uncachedTokens` are not yet cached:
 *
 *   NKeep = nominalWork / etaKeep
 *   NFold = nominalWork / etaFold
 *   directValue      = (pMiss - pHit) * uncachedTokens + NFold * pHit * poolTokens
 *   degradationValue = (NKeep - NFold) * (keepContext * pHit + K_non)
 *
 * The two terms are exact and non-negative. They also satisfy the Bellman
 * identity used by `accrue`:
 *
 *   NKeep * poolTurnRent(...) === NFold * pHit * poolTokens
 *                                + degradationValue
 *
 * so historical sunk rent and future expected savings share one ruler.
 */
export function futureFoldSavings({
	nominalWork,
	poolTokens,
	uncachedTokens = 0,
	contextTokens,
	contextWindow,
	pHit,
	pMiss,
	nonContextTurnCost = 0,
}) {
	const work = finiteNonNegative(nominalWork);
	const pool = finiteNonNegative(poolTokens);
	const uncached = Math.min(pool, finiteNonNegative(uncachedTokens));
	const hit = finiteNonNegative(pHit);
	const miss = finiteNonNegative(pMiss);
	const window = usableWindow(contextWindow);
	const context = usableContext(contextTokens);

	if (work <= 0 || pool <= 0 || window === null || context === null) {
		const directValue = work > 0 ? (miss - hit) * uncached + work * hit * pool : 0;
		return {
			total: directValue,
			directValue,
			degradationValue: 0,
			etaKeep: 1,
			etaFold: 1,
			nKeep: work,
			nFold: work,
			savedTurns: 0,
		};
	}

	const keepContext = Math.max(context, pool);
	const foldContext = keepContext - pool;
	const etaKeep = contextEfficiency(keepContext, window);
	const etaFold = contextEfficiency(foldContext, window);
	const nKeep = work / etaKeep;
	const nFold = work / etaFold;
	const savedTurns = Math.max(0, nKeep - nFold);
	const nonContext = finiteNonNegative(nonContextTurnCost);

	const directValue = (miss - hit) * uncached + nFold * hit * pool;
	const degradationValue = savedTurns * (keepContext * hit + nonContext);
	return {
		total: directValue + degradationValue,
		directValue,
		degradationValue,
		etaKeep,
		etaFold,
		nKeep,
		nFold,
		savedTurns,
	};
}
