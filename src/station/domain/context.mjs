// Pure context projection for the Station.
//
// The Station owns `state` and `usage`; this module owns the decision. It takes
// plain data and returns a plain patch. It never imports the Station class or a
// host module, and it never mutates its inputs.
//
// `projectContext(snapshot, ctx)`:
//   snapshot = { amends }
//   ctx      = { original, tree, needsRebase, ports, modelKey, header, firstTurn }
//              firstTurn = [{ role, content }], the recorded opening exchange
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

// The synthetic opening claims no host identity: it is provider-neutral
// history, so every outbound request converts it the same way regardless of
// which model answers. A constant timestamp keeps the shared prefix
// byte-identical, so the provider's prompt cache can reuse it each turn.
const FIRST_TURN_TIMESTAMP = 1;
const FIRST_TURN_API = "openai-completions";
const FIRST_TURN_PROVIDER = "herdchestra";
const FIRST_TURN_MODEL = "shared-opening";

function firstTurnUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

/**
 * The recorded content keeps its parts verbatim, apart from the state only a
 * live stream carries. A capture records `partialArgs` and `streamIndex` while
 * the call is still arriving; a replay is finished history, and a host that
 * sees those flags treats the call as unfinished, leaving its `toolResult`
 * without a call.
 */
function firstTurnContent(content) {
	if (!Array.isArray(content)) return content;
	return content.map((part) => {
		if (part?.type !== "toolCall") return part;
		const { partialArgs, streamIndex, ...rest } = part;
		return rest;
	});
}

/** A turn that ends in a tool call stopped to use it, not to answer. */
function firstTurnStopReason(content) {
	const calling =
		Array.isArray(content) && content.some((part) => part?.type === "toolCall");
	return calling ? "toolUse" : "stop";
}

/**
 * Make one recorded turn a complete host message.
 *
 * A bare `{ role, content }` is not enough: the host treats an assistant
 * message as real history and reads `api`, `provider`, `model`, `usage`,
 * `stopReason`, and `timestamp` while preparing the request. A synthetic turn
 * without them aborts a DeepSeek-compatible child before its first answer.
 */
export function firstTurnMessage(message) {
	const role = message?.role;
	const content = firstTurnContent(message?.content);
	if (role === "assistant") {
		return {
			...message,
			role,
			content,
			api: FIRST_TURN_API,
			provider: FIRST_TURN_PROVIDER,
			model: FIRST_TURN_MODEL,
			usage: firstTurnUsage(),
			stopReason: firstTurnStopReason(content),
			timestamp: FIRST_TURN_TIMESTAMP,
			attribution: "assistant",
		};
	}
	if (role === "user") {
		return {
			...message,
			role,
			content,
			timestamp: FIRST_TURN_TIMESTAMP,
			attribution: "user",
			synthetic: true,
		};
	}
	return {
		...message,
		role,
		content,
		timestamp: message?.timestamp ?? FIRST_TURN_TIMESTAMP,
	};
}

/**
 * Put the shared opening block before the conversation, after any leading
 * system/developer preamble. A user message before a system message is
 * invalid on providers that require the system prompt first.
 */
export function prependFirstTurn(messages, turn) {
	if (!Array.isArray(turn) || turn.length === 0) return messages;
	let at = 0;
	while (at < messages.length) {
		const role = messages[at]?.role;
		if (role !== "system" && role !== "developer") break;
		at += 1;
	}
	const head = turn.map(firstTurnMessage);
	return [...messages.slice(0, at), ...head, ...messages.slice(at)];
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
