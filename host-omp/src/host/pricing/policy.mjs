// Cache economics: what one turn costs for a given model entry.
//
// A policy is three per-token prices plus the context window. It is derived from
// a catalog entry, never stored, so a corrected price table takes effect on the
// next read.

import { asNonNegativeNumber, asPositiveNumber } from "./ingest.mjs";

/** Convert a character count into an estimated token count. */
export function charsToTokens(chars, tokensPerChar = 0.3) {
	const count = Number(chars);
	const rate =
		Number.isFinite(tokensPerChar) && tokensPerChar >= 0 ? tokensPerChar : 0.3;
	return Number.isFinite(count) && count > 0 ? count * rate : 0;
}

function numOrZero(value) {
	return asNonNegativeNumber(value) ?? 0;
}

/** Per-token policy for one catalog entry. */
export function policyFromCatalogEntry(entry) {
	const cost = entry.cost ?? {};
	const pHit = numOrZero(cost.cacheRead ?? cost.input) / 1e6;
	const writeSource =
		asPositiveNumber(cost.cacheWrite) !== null ? cost.cacheWrite : cost.input;
	const pMiss = numOrZero(writeSource) / 1e6;
	const pOut = numOrZero(cost.output) / 1e6;
	return {
		pHit,
		pMiss,
		pOut,
		contextWindow: asPositiveNumber(entry.contextWindow),
		knownPricing: true,
		label: entry.label ?? entry.id ?? "model",
	};
}
