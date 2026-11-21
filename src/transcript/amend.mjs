// Transcript amend: find and remove the beats an amend retires. Pure.

import {
	beatKey,
	exitBeat,
	findToolCallIndex,
	reject,
	toolCalls,
} from "./messages.mjs";

/** The three calls that own a bracket pair. None is an amend target. */
const STRUCTURAL_TOOLS = new Set(["scope_fork", "scope_join", "scope_return"]);

/**
 * The assistant index of the branch's most recent structural call before
 * `beforeIndex`, or -1 when this branch has made none.
 */
export function lastStructuralCallId(messages, beforeIndex = Infinity) {
	if (!Array.isArray(messages)) return null;
	const limit = Number.isInteger(beforeIndex)
		? Math.min(beforeIndex, messages.length)
		: messages.length;
	for (let index = limit - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const call = toolCalls(message).find((entry) => STRUCTURAL_TOOLS.has(entry.name));
		if (call) return call.id;
	}
	return null;
}

/**
 * Find the nearest earlier beat that an amend may remove.
 *
 * `boundary` names the branch and the structural call that closes its past:
 * `{ ownerId, afterToolCallId }`. A beat at or before that call is out of
 * reach, and a beat that itself carries a structural call is never removed.
 * The current assistant message is in flight and is never a target.
 */
export function findAmendTarget(state, messages, currentAssistantIndex, boundary = {}) {
	const { ownerId = null, afterToolCallId = null } = boundary;
	if (!Array.isArray(messages) || messages.length === 0) {
		return reject("NO_BEAT", "The transcript has no assistant beat.");
	}

	// The boundary is a call id; its message may already be gone after a host
	// compaction. When it is gone, the branch itself still bounds the search,
	// because every message here belongs to this branch.
	const boundaryIndex =
		typeof afterToolCallId === "string" && afterToolCallId !== ""
			? findToolCallIndex(messages, afterToolCallId)
			: -1;

	const amends = new Set(Array.isArray(state?.amends) ? state.amends : []);
	const charges = state?.charges ?? {};
	const lastIndex = Math.min(currentAssistantIndex - 1, messages.length - 1);

	for (let index = lastIndex; index >= 0; index -= 1) {
		const message = messages[index];
		// A retired working-level boundary is history. It is never amendable
		// across, because the record on the other side was already accounted
		// for by a protocol this branch no longer runs.
		if (message?.role === "custom" && message.customType === "scope.end") {
			return reject("STRUCTURAL_BOUNDARY", "A retired scope boundary is not amendable across.");
		}
		if (message?.role !== "assistant") continue;
		if (amends.has(beatKey(message))) continue;

		if (boundaryIndex >= 0 && index <= boundaryIndex) {
			return reject(
				"STRUCTURAL_BOUNDARY",
				"The candidate is at or before the branch's most recent structural call.",
			);
		}

		const calls = toolCalls(message);
		if (calls.some((call) => STRUCTURAL_TOOLS.has(call.name))) {
			return reject("STRUCTURAL_BOUNDARY", "A structural call is not an amend target.");
		}

		const foreign = calls.find((call) => {
			const charge = charges[call.id];
			return charge !== undefined && (charge.ownerId ?? null) !== (ownerId ?? null);
		});
		if (foreign) {
			return reject("OUTSIDE_SCOPE", `Tool call ${foreign.id} belongs to another branch.`);
		}

		return { ok: true, beat: exitBeat(messages, index), toolCalls: calls };
	}

	return reject("NO_BEAT", "No earlier assistant beat remains on this branch.");
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

export { STRUCTURAL_TOOLS };
