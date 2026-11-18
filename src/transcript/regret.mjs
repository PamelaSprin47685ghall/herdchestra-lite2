// Transcript regret: find and remove the beats a regret undoes. Pure.

import {
	beatKey,
	exitBeat,
	findToolCallIndex,
	reject,
	toolCalls,
} from "./messages.mjs";

const SCOPE_TOOL_NAME = "scope";

/**
 * Find the nearest earlier beat that regret may remove.
 *
 * The current assistant message is in flight and is never a target.
 */
export function findRegretTarget(state, messages, currentAssistantIndex, scope) {
	if (!scope) return reject("OUTSIDE_SCOPE", "Regret requires an active scope.");
	if (!Array.isArray(messages) || messages.length === 0) {
		return reject("NO_BEAT", "The transcript has no assistant beat.");
	}

	const beginAssistantIndex = findToolCallIndex(messages, scope.beginToolCallId);
	if (beginAssistantIndex < 0) {
		return reject("SCOPE_BOUNDARY", "The scope begin message is not in the transcript.");
	}

	const regrets = new Set(Array.isArray(state?.regrets) ? state.regrets : []);
	const charges = state?.charges ?? {};
	const lastIndex = Math.min(currentAssistantIndex - 1, messages.length - 1);

	for (let index = lastIndex; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (regrets.has(beatKey(message))) continue;

		if (index <= beginAssistantIndex) {
			return reject("SCOPE_BOUNDARY", "The candidate is at or before the scope begin.");
		}

		const calls = toolCalls(message);
		if (calls.some((call) => call.name === SCOPE_TOOL_NAME)) {
			return reject("SCOPE_BOUNDARY", "A scope call is not a regret target.");
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

/** Remove the messages of every regretted beat. */
export function filterRegrets(messages, regrets) {
	const source = Array.isArray(messages) ? messages : [];
	const regretSet = new Set(Array.isArray(regrets) ? regrets : []);
	if (regretSet.size === 0) return source.slice();

	const droppedMessages = new Set();
	const droppedToolCallIds = new Set();
	for (const message of source) {
		if (message?.role !== "assistant" || !regretSet.has(beatKey(message))) continue;
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
