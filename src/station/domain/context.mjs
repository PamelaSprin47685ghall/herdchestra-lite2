// Pure context projection for the Station.
//
// The Station owns `state` and `usage`; this module owns the decision. It takes
// plain data and returns a plain patch. It never imports the Station class or a
// host module, and it never mutates its inputs.
//
// `projectContext(snapshot, ctx)`:
//   snapshot = { amends }
//   ctx      = { original, tree, needsRebase, ports, modelKey, header, firstTurn }
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

/**
 * A fixed opening message shared by every outbound request. The timestamp is
 * constant so the provider sees a byte-identical prefix on every call; a
 * clock reading would invalidate the prompt cache each turn.
 */
export function firstTurnMessage(text) {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
		attribution: "user",
	};
}

/**
 * Put the shared first turn before the conversation, after any leading
 * system/developer preamble. A user message before a system message is
 * invalid on providers that require the system prompt first.
 */
export function prependFirstTurn(messages, text) {
	if (typeof text !== "string" || text === "") return messages;
	let at = 0;
	while (at < messages.length) {
		const role = messages[at]?.role;
		if (role !== "system" && role !== "developer") break;
		at += 1;
	}
	return [
		...messages.slice(0, at),
		firstTurnMessage(text),
		...messages.slice(at),
	];
}

export function projectContext(snapshot = {}, input = {}) {
	const amends = Array.isArray(snapshot.amends) ? snapshot.amends : [];
	const original = Array.isArray(input.original) ? input.original : [];
	let messages = filterAmends(original, amends);
	const projectedLength = messages.length;

	// `messages` is the outbound list: amends removed entries, so its length is
	// not a position in the branch. The economics compare a cache's
	// `cachedUntilPos` against branch indexes, so record the highest branch
	// position the provider actually saw.
	let outboundFrontier = -1;
	for (const message of messages) {
		const at = original.indexOf(message);
		if (at > outboundFrontier) outboundFrontier = at;
	}

	const ports = input.ports && typeof input.ports === "object" ? input.ports : {};
	messages = messages.map((message) => rewriteVibeMessage(message, ports));
	messages = prependFirstTurn(messages, input.firstTurn);

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
				frontier:
					outboundFrontier >= 0 ? outboundFrontier + 1 : projectedLength,
			}
		: null;

	return {
		messages,
		rebase,
		usage,
	};
}
