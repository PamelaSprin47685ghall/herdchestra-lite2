// Transcript amend: find and remove the beats an amend retires. Pure.

import {
	beatKey,
	exitBeat,
	findToolCallIndex,
	reject,
	toolCalls,
} from "./messages.mjs";

const SCOPE_TOOL_NAME = "scope";

/**
 * Find the nearest earlier beat that an amend may remove.
 *
 * The current assistant message is in flight and is never a target.
 */
export function findAmendTarget(state, messages, currentAssistantIndex, scope) {
	if (!scope) return reject("OUTSIDE_SCOPE", "Amend requires an active scope.");
	if (!Array.isArray(messages) || messages.length === 0) {
		return reject("NO_BEAT", "The transcript has no assistant beat.");
	}

	// A flow's begin id is `batchCallId:index`; no tool call carries that id.
	// Its boundary is the flow's own `scope.begin` custom message (or the
	// batch's tool result when the custom entry is not in this window). Find
	// the newest such boundary so the search never crosses into a sibling's
	// copied segment.
	let beginAssistantIndex = findToolCallIndex(messages, scope.beginToolCallId);
	if (beginAssistantIndex < 0) {
		const batchCallId = scope.beginToolCallId.replace(/:\d+$/, "");
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role === "custom" && message.customType === "scope.begin") {
				beginAssistantIndex = index;
				break;
			}
			if (message?.role === "toolResult" && message.toolCallId === batchCallId) {
				beginAssistantIndex = index;
				break;
			}
		}
	}
	if (beginAssistantIndex < 0) {
		return reject("SCOPE_BOUNDARY", "The scope begin message is not in the transcript.");
	}

	const amends = new Set(Array.isArray(state?.amends) ? state.amends : []);
	const charges = state?.charges ?? {};
	const lastIndex = Math.min(currentAssistantIndex - 1, messages.length - 1);

	for (let index = lastIndex; index >= 0; index -= 1) {
		const message = messages[index];
		// A closed scope — a nested sibling's end, or a segment copied from
		// another flow — is a hard boundary. Amending across it would revive a
		// beat the closed scope already accounted for.
		if (message?.role === "custom" && message.customType === "scope.end") {
			return reject("SCOPE_BOUNDARY", "A closed scope boundary is not amendable across.");
		}
		if (message?.role !== "assistant") continue;
		if (amends.has(beatKey(message))) continue;

		if (index <= beginAssistantIndex) {
			return reject("SCOPE_BOUNDARY", "The candidate is at or before the scope begin.");
		}

		const calls = toolCalls(message);
		if (calls.some((call) => call.name === SCOPE_TOOL_NAME)) {
			return reject("SCOPE_BOUNDARY", "A scope call is not an amend target.");
		}

		const foreign = calls.find((call) => {
			const charge = charges[call.id];
			return charge !== undefined && charge.scopeId !== scope.id;
		});
		if (foreign) {
			return reject("OUTSIDE_SCOPE", `Tool call ${foreign.id} belongs to another scope.`);
		}

		return { ok: true, beat: exitBeat(messages, index), toolCalls: calls };
	}

	return reject("NO_BEAT", "No earlier assistant beat remains in this scope.");
}

/** Remove the messages of every amended beat. */
export function filterAmends(messages, amends) {
	const source = Array.isArray(messages) ? messages : [];
	const amendSet = new Set(Array.isArray(amends) ? amends : []);
	if (amendSet.size === 0) return source.slice();

	const droppedMessages = new Set();
	const droppedToolCallIds = new Set();
	for (const message of source) {
		if (message?.role !== "assistant" || !amendSet.has(beatKey(message))) continue;
		droppedMessages.add(message);
		for (const call of toolCalls(message)) droppedToolCallIds.add(call.id);
	}

	const kept = [];
	for (const message of source) {
		if (droppedMessages.has(message)) continue;
		if (message?.role === "toolResult" && droppedToolCallIds.has(message.toolCallId)) continue;
		kept.push(message);
	}
	return kept;
}
