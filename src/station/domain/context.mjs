// Pure context projection for the Station.
//
// The Station owns `state` and `usage`; this module owns the decision. It takes
// plain data and returns a plain patch. It never imports the Station class or a
// host module, and it never mutates its inputs.
//
// `projectContext(snapshot, ctx, { folding })`:
//   snapshot = { receipts, amends }
//   ctx      = { original, tree, needsRebase, ports, modelKey, header }
//   folding  = { foldable(receipts), apply(messages, receipts, { foldable }) }
//
// Returns:
//   {
//     messages,                 // projected outbound list
//     nextState: { receipts },  // receipts with this pass's collapses marked
//     collapsed,                // ids shortened by this pass
//     rebase,                   // host tree tail still matches the outbound list
//     usage,                    // { key, messages, header, frontier } or null
//   }

import { filterAmends } from "../../transcript/amend.mjs";
import { rewriteVibeMessage } from "../../transcript/tail.mjs";
import { markCollapsed } from "../../scope/receipts.mjs";
import { sameTail } from "../messages.mjs";

const NO_FOLDING = Object.freeze({
	foldable: () => [],
	apply: (messages) => ({ messages, collapsed: [] }),
});

/** Mark every collapsed receipt id, without mutating the input list. */
export function settleReceipts(receipts, closeToolCallIds) {
	let next = Array.isArray(receipts) ? receipts : [];
	for (const id of Array.isArray(closeToolCallIds) ? closeToolCallIds : []) {
		next = markCollapsed(next, id);
	}
	return next;
}

/** The host tree may be replaced only when its tail is still the outbound tail. */
export function shouldRebase({ needsRebase, tree, outbound } = {}) {
	if (needsRebase !== true) return false;
	return sameTail(tree, outbound);
}

export function projectContext(snapshot = {}, ctx = {}, { folding = NO_FOLDING } = {}) {
	const receipts = Array.isArray(snapshot.receipts) ? snapshot.receipts : [];
	const amends = Array.isArray(snapshot.amends) ? snapshot.amends : [];
	const original = Array.isArray(ctx.original) ? ctx.original : [];
	let messages = filterAmends(original, amends);

	// Receipts are the only fold target. The projection shortens an old right
	// bracket without removing its left bracket, so the structure of every fork
	// stays readable and restorable.
	const foldable =
		typeof folding.foldable === "function" ? folding.foldable(receipts) : [];
	let collapsed = [];
	if (foldable.length > 0 && typeof folding.apply === "function") {
		const folded = folding.apply(messages, receipts, { foldable });
		if (Array.isArray(folded?.messages)) messages = folded.messages;
		if (Array.isArray(folded?.collapsed)) collapsed = folded.collapsed;
	}

	// `messages` is the outbound list: amends removed entries and collapses
	// replaced whole intervals, so its length is not a position in the branch.
	// The economics compare a cache's `cachedUntilPos` against branch indexes,
	// so record the highest branch position the provider actually saw.
	let outboundFrontier = -1;
	for (const message of messages) {
		const at = original.indexOf(message);
		if (at > outboundFrontier) outboundFrontier = at;
	}

	const ports = ctx.ports && typeof ctx.ports === "object" ? ctx.ports : {};
	messages = messages.map((message) => rewriteVibeMessage(message, ports));

	const nextReceipts = settleReceipts(receipts, collapsed);
	const rebase = shouldRebase({
		needsRebase: ctx.needsRebase === true,
		tree: ctx.tree,
		outbound: messages,
	});
	const usage = ctx.modelKey
		? {
				key: ctx.modelKey,
				messages,
				header: ctx.header ?? null,
				frontier:
					outboundFrontier >= 0 ? outboundFrontier + 1 : messages.length,
			}
		: null;

	return {
		messages,
		nextState: { receipts: nextReceipts },
		collapsed,
		rebase,
		usage,
	};
}
