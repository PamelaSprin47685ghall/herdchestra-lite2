// Pure ledger precedence for fork wiring.
//
// A station and its wiring must agree on which bracket ledger a session uses.
// The rule lives here once: identity first, then a live index that already
// holds forks, then the restored tree, then the empty index. The only write is
// the documented totals fill on the chosen ledger, so a reload keeps turn
// samples even when the restored tree has no open forks.

import { normalizeTotals } from "../../scope/turn-stats.mjs";
import { replaceTotals } from "../../scope/ledger-cache.mjs";

/**
 * Choose the ledger a station must use.
 *
 * Returns `{ ledger, source, filled, adopt }`:
 * - source: "identity" | "indexed" | "restored" | "created" | "none"
 * - filled: true when the chosen ledger received the other candidate's totals.
 * - adopt: true when the caller must publish the chosen ledger back to the
 *   registry, that is whenever it is not the live index.
 *
 * `create` is the one difference between the two callers: the wiring never
 * mints a ledger, and the station constructor mints an empty one when neither
 * candidate exists.
 */
export function selectForkLedger({
	identity = null,
	indexed = null,
	restored = null,
	create = null,
} = {}) {
	if (identity?.ledger && typeof identity.ledger === "object") {
		return { ledger: identity.ledger, source: "identity", filled: false, adopt: true };
	}
	const indexedLive = (indexed?.order?.length ?? 0) > 0;
	const restoredLive = (restored?.order?.length ?? 0) > 0;
	let ledger = null;
	if (indexedLive) ledger = indexed;
	else if (restoredLive) ledger = restored;
	else if (typeof create === "function") ledger = indexed ?? restored ?? create();
	else ledger = restored ?? indexed ?? null;
	// A live index is already published, so only the station republishing it is
	// a no-op; an empty index still has to be adopted.
	const adopt = !(indexedLive && ledger === indexed);
	const other = ledger === indexed ? restored : indexed;
	let filled = false;
	// Never sum or overwrite two sampled ledgers.
	if (ledger && other && ledger !== other) {
		const chosenTotals = normalizeTotals(ledger.totals);
		const otherTotals = normalizeTotals(other.totals);
		const chosenHasSamples = chosenTotals.turns > 0 || chosenTotals.turnMs > 0;
		const otherHasSamples = otherTotals.turns > 0 || otherTotals.turnMs > 0;
		if (!chosenHasSamples && otherHasSamples) {
			replaceTotals(ledger, otherTotals);
			filled = true;
		}
	}
	const source =
		ledger === null
			? "none"
			: ledger === indexed
				? "indexed"
				: ledger === restored
					? "restored"
					: "created";
	return { ledger, source, filled, adopt };
}

/**
 * Resolve a station's ledger and record the binding on the process container.
 *
 * `process.ledgerByConversation` is the explicit replacement for the
 * `Symbol.for` slot a ledger used to carry: the index is a real field on the
 * object the composition root owns, so a parent and its child reach the same
 * ledger by reading the same map instead of by agreeing on a global symbol. A
 * cached index is offered to `selectForkLedger` as the live index, which is
 * exactly what that slot means.
 *
 * Returns the selection plus `adopted`: true when the chosen ledger was also
 * published back through `adoptLedger`.
 */
export function bindProcessLedger(
	process,
	{
		key = null,
		identity = null,
		indexed = null,
		restored = null,
		create = null,
		ledgerFor = null,
		adoptLedger = null,
	} = {},
) {
	const cache = process?.ledgerByConversation ?? null;
	// The root conversation is a conversation: `null` is a real key, not the
	// absence of one. Only an identity asks for a different ledger than the
	// conversation's index.
	const cached = cache ? (cache.get(key) ?? null) : null;
	const live =
		cached ??
		(typeof ledgerFor === "function" ? ledgerFor(process?.registry ?? null, key) ?? indexed : indexed);
	const selected = selectForkLedger({
		identity,
		indexed: identity ? null : live,
		restored,
		create,
	});
	const { ledger } = selected;
	if (cache && ledger) cache.set(key, ledger);
	// A child inherits its parent's ledger; publishing it back would overwrite
	// the conversation's own index.
	const adopted =
		!identity &&
		selected.adopt !== false &&
		typeof adoptLedger === "function" &&
		ledger !== null;
	if (adopted) adoptLedger(process?.registry ?? null, key, ledger);
	return { ...selected, adopted };
}
