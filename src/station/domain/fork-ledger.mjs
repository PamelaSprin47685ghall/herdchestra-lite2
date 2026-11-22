// Pure ledger precedence for fork wiring.
//
// A station and its wiring must agree on which bracket ledger a session uses.
// The rule lives here once: identity first, then a live index that already
// holds forks, then the restored tree, then the empty index. The only write is
// the documented totals fill on the chosen ledger, so a reload keeps turn
// samples even when the restored tree has no open forks.

import { normalizeTotals } from "../../scope/turn-stats.mjs";

/**
 * Choose the ledger a station must use.
 *
 * Returns `{ ledger, source, filled }`:
 * - source: "identity" | "indexed" | "restored" | "none"
 * - filled: true when the chosen ledger received the other candidate's totals.
 */
export function selectForkLedger({
	identity = null,
	indexed = null,
	restored = null,
} = {}) {
	if (identity?.ledger && typeof identity.ledger === "object") {
		return { ledger: identity.ledger, source: "identity", filled: false };
	}
	const indexedLive = (indexed?.order?.length ?? 0) > 0;
	const chosen = indexedLive ? indexed : (restored ?? indexed ?? null);
	const other = chosen === indexed ? restored : indexed;
	let filled = false;
	// Never sum or overwrite two sampled ledgers.
	if (chosen && other && chosen !== other) {
		const chosenTotals = normalizeTotals(chosen.totals);
		const otherTotals = normalizeTotals(other.totals);
		const chosenHasSamples = chosenTotals.turns > 0 || chosenTotals.turnMs > 0;
		const otherHasSamples = otherTotals.turns > 0 || otherTotals.turnMs > 0;
		if (!chosenHasSamples && otherHasSamples) {
			chosen.totals = otherTotals;
			filled = true;
		}
	}
	const source =
		chosen === null
			? "none"
			: chosen === restored && !indexedLive
				? "restored"
				: "indexed";
	return { ledger: chosen, source, filled };
}
