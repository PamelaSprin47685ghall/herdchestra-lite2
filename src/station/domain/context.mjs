// Pure context projection for the Station.
//
// The Station owns `state` and `usage`; this module owns the decision. It takes
// plain data and returns a plain patch. It never imports the Station class or a
// host module, and it never mutates its inputs.
//
// `projectContext(snapshot, ctx)`:
//   snapshot = { amends }
//   ctx      = { original, tree, needsRebase, ports, modelKey, header }
//
// Returns:
//   {
//     messages,                 // projected outbound list
//     rebase,                   // host tree tail still matches the outbound list
//     usage,                    // { key, messages, header, frontier } or null
//   }

import { filterAmends } from "../../transcript/amend.mjs";
import { rewriteVibeMessage } from "../../transcript/tail.mjs";
import { sameTail } from "../messages.mjs";

/** The host tree may be replaced only when its tail is still the outbound tail. */
export function shouldRebase({ needsRebase, tree, outbound } = {}) {
	if (needsRebase !== true) return false;
	return sameTail(tree, outbound);
}

export function projectContext(snapshot = {}, ctx = {}) {
	const amends = Array.isArray(snapshot.amends) ? snapshot.amends : [];
	const original = Array.isArray(ctx.original) ? ctx.original : [];
	let messages = filterAmends(original, amends);

	// `messages` is the outbound list: amends removed entries, so its length is
	// not a position in the branch. The economics compare a cache's
	// `cachedUntilPos` against branch indexes, so record the highest branch
	// position the provider actually saw.
	let outboundFrontier = -1;
	for (const message of messages) {
		const at = original.indexOf(message);
		if (at > outboundFrontier) outboundFrontier = at;
	}

	const ports = ctx.ports && typeof ctx.ports === "object" ? ctx.ports : {};
	messages = messages.map((message) => rewriteVibeMessage(message, ports));

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
		rebase,
		usage,
	};
}
