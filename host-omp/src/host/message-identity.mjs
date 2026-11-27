/**
 * Message identity: the single owner of "is this the same message?".
 *
 * Three copies of one message exist at request time: the live loop frame the
 * model produced, the journal entry the host persisted, and the enriched
 * snapshot AgentSession writes. They are different objects, and the persisted
 * copy carries bookkeeping the loop copy never had. Every comparison in the
 * extension answers one question — did the host already commit this message? —
 * so every comparator lives here.
 *
 * The comparators are deliberately of three strengths and must not be folded
 * together:
 * - `sameMessage`: byte identity (JSON), used for journal writes.
 * - `sameAssistantFrame`: assistant identity by stable content plus the fields
 *   the provider assigned (timestamp, model, responseId, stopReason).
 * - `sameInputContent` / `samePersistedInputMessage`: input identity, which
 *   tolerates the runtime fields the host adds (ISO timestamps, attribution
 *   defaults, `excludeFromContext`).
 */

import { isDeepStrictEqual } from "node:util";

/** The input-side roles: messages a user or a hook contributes, not model output. */
export const INPUT_ROLES = new Set(["user", "developer", "custom", "fileMention", "hookMessage"]);

/** Byte identity. Used to prove the journal retained exactly what was written. */
export function sameMessage(left, right) {
	return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Compare two assistant frames across loop/journal copies.
 *
 * Core keeps the final provider frame in the loop and publishes a snapshot
 * that AgentSession enriches for persistence. Compare content and its stable
 * identity, not that bookkeeping; neither copy is changed for replay.
 */
export function sameAssistantFrame(left, right) {
	return left?.role === "assistant" && right?.role === "assistant" && Number.isFinite(right.timestamp) &&
		left.timestamp === right.timestamp && left.provider === right.provider && left.api === right.api &&
		left.model === right.model && (left.responseId ?? "") === (right.responseId ?? "") &&
		left.stopReason === right.stopReason && isDeepStrictEqual(left.content, right.content);
}

export function normalizedTimestamp(value) {
	if (Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

export function sameInputAttribution(role, left, right) {
	if (left === right) return true;
	if (role === "custom" || role === "hookMessage") {
		return (left ?? "agent") === (right ?? "agent");
	}
	if (role === "user") {
		return (left ?? "user") === (right ?? "user");
	}
	return left === undefined || right === undefined;
}

export function sameInputContent(left, right) {
	if (left?.role === "fileMention") {
		return isDeepStrictEqual(left.files, right.files) && isDeepStrictEqual(left.content, right.content);
	}
	return isDeepStrictEqual(left.content, right.content) || sameMessage(left.content, right.content);
}

/**
 * Compare two input-side messages across loop/live/journal copies.
 * The host normalizes and enriches persisted input copies (stripping display
 * details, adding entry metadata, setting `liveSteered`, or formatting ISO
 * timestamps). Match stable input identity without those runtime fields.
 */
export function samePersistedInputMessage(left, right) {
	if (!left || !right || left.role !== right.role || !INPUT_ROLES.has(left.role)) return false;
	if (left.role === "custom" || left.role === "hookMessage") {
		if (left.customType !== right.customType) return false;
	}
	if (!sameInputContent(left, right)) return false;
	if (normalizedTimestamp(left.timestamp) !== normalizedTimestamp(right.timestamp)) return false;
	if (!sameInputAttribution(left.role, left.attribution, right.attribution)) return false;
	return (left.excludeFromContext === true) === (right.excludeFromContext === true);
}

/** The tool-call ids a message declares. */
export function toolCallIds(message) {
	const ids = new Set();
	const content = message?.content;
	if (!Array.isArray(content)) return ids;
	for (const item of content) {
		if (item?.type === "toolCall" && typeof item.id === "string") ids.add(item.id);
	}
	return ids;
}

/**
 * Compare a live message with the snapshot AgentSession persisted for it.
 *
 * AgentSession persists an enriched snapshot of the emitted message. Its
 * persistence key is the host's stable identity for that separate object.
 * Only assistant frames and tool results have one; an input message is matched
 * by `samePersistedInputMessage` and never by this enrichment path.
 */
export function samePersistedMessage(live, committed) {
	if (sameAssistantFrame(live, committed) || isDeepStrictEqual(live, committed)) return true;
	if (samePersistedInputMessage(live, committed)) return true;
	if (live?.role !== committed?.role) return false;
	const sameContent = Array.isArray(live.content) && Array.isArray(committed.content) &&
		isDeepStrictEqual(live.content, committed.content);
	if (!sameContent) return false;
	if (live.role === "assistant") {
		return Number.isFinite(committed.timestamp) &&
			live.timestamp === committed.timestamp &&
			live.provider === committed.provider &&
			live.model === committed.model &&
			(live.responseId ?? "") === (committed.responseId ?? "") &&
			live.stopReason === committed.stopReason;
	}
	if (live.role === "toolResult") {
		return live.timestamp === committed.timestamp &&
			live.toolCallId === committed.toolCallId &&
			live.toolName === committed.toolName;
	}
	return false;
}

/** The tool-call ids of the last assistant frame in a committed prefix. */
export function committedToolCallIds(prefix) {
	for (let index = prefix.length - 1; index >= 0; index -= 1) {
		const message = prefix[index];
		if (message?.role === "assistant") return toolCallIds(message);
	}
	return new Set();
}

export function isSkill(message) {
	return message?.herdSkill === true;
}

/** Index of the trailing skill-receipt run, i.e. where the request's turn starts. */
export function receiptStart(messages) {
	let index = messages.length;
	while (index > 0 && isSkill(messages[index - 1])) index -= 1;
	return index;
}

/** Whether the host keeps this message out of the journal. */
export function journalOmits(message) {
	if (message?.excludeFromContext === true) return true;
	const custom = message?.role === "custom";
	const hook = message?.role === "hookMessage";
	// AgentSession.#persistMessageEnd consumes these notes within one run.
	// Other custom input is persisted and must pass the journal check.
	if ((custom || hook) && (message.customType === "vibe-mode-context" || message.customType === "plan-mode-context")) {
		return true;
	}
	if (custom && message.customType === "prewalk-plan") return true;
	// The scheduler renders these from its own state entries.
	return custom && /^scope\.(begin|end)$/.test(message.customType);
}

/** The last message of a turn: the last one that is neither a receipt nor omitted. */
export function lastTurnMessage(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isSkill(message) && !journalOmits(message)) return message;
	}
	return undefined;
}

/** Whether two turns end at the same message, at any of the three strengths. */
export function sameTurnMessage(left, right) {
	if (left === right || sameAssistantFrame(left, right) || sameMessage(left, right)) return true;
	return samePersistedInputMessage(left, right);
}
