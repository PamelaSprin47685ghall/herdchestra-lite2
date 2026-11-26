// Pure context projection for the Station.
//
// The Station owns `state` and `usage`; this module owns the decision. It takes
// plain data and returns a plain patch. It never imports the Station class or a
// host module, and it never mutates its inputs.
//
// `projectContext(snapshot, ctx)`:
//   snapshot = {}                        (reserved for future pure inputs)
//   ctx      = { original, tree, needsRebase, ports, modelKey, header }
//
// Returns:
//   {
//     messages,                 // projected outbound list
//     rebase,                   // host tree tail still matches the outbound list
//     usage,                    // { key, messages, header, frontier } or null
//   }

import { rewriteVibeMessage } from "../../transcript/tail.mjs";
import { sameTail } from "../messages.mjs";

/** The host tree may be replaced only when its tail is still the outbound tail. */
export function shouldRebase({ needsRebase, tree, outbound } = {}) {
	if (needsRebase !== true) return false;
	return sameTail(tree, outbound);
}

export function projectContext(_snapshot = {}, input = {}) {
	const original = Array.isArray(input.original) ? input.original : [];
	const ports = input.ports && typeof input.ports === "object" ? input.ports : {};
	const messages = original.map((message) => rewriteVibeMessage(message, ports));

	const rebase = shouldRebase({
		needsRebase: input.needsRebase === true,
		tree: input.tree,
		outbound: messages,
	});
	const usage = input.modelKey
		? {
				key: input.modelKey,
				messages,
				header: input.header ?? null,
				frontier: messages.length,
			}
		: null;

	return {
		messages,
		rebase,
		usage,
	};
}
