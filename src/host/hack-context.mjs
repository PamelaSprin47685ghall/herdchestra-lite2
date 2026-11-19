// Context-event wrapper, patterned after HerdchestraLite's bridge.hack-context.
// The extension context handler rebuilds the full outbound message list every
// turn. This wrapper appends its trailing dynamic skill message into session
// history so request, in-memory history and on-disk history stay consistent;
// the next request then replays the same prefix instead of breaking the
// provider cache when an ephemeral tail disappears.

import { messagesOf } from "./adapter.mjs";

/**
 * The single history-write channel. Append one message to disk, and, when a
 * live session is available, to its in-memory transcript as well. All writers
 * (skill receipts, folds, handoff checkpoints) go through here.
 */
export function appendHistoryMessage(manager, message, source = null) {
	if (!manager || typeof manager.appendMessage !== "function") return false;
	try {
		manager.appendMessage(message);
	} catch {
		return false;
	}
	if (source) {
		try {
			const messages = messagesOf(source);
			if (messages && !messages.includes(message)) messages.push(message);
		} catch {
			// A host without a live agent still got the manager entry.
		}
	}
	return true;
}

function textOf(message) {
	if (!message || typeof message !== "object") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function sameMessage(a, b) {
	return Boolean(a && b) && a.role === b.role && textOf(a) === textOf(b);
}

function lastPersistedMessage(manager) {
	const branch = typeof manager.getBranch === "function" ? manager.getBranch() : [];
	let last = null;
	for (const entry of branch ?? []) {
		if (entry?.type === "message" && entry.message) last = entry.message;
	}
	return last;
}

function persistSkill(manager, skill) {
	if (!manager || typeof manager.appendMessage !== "function") return;
	if (sameMessage(lastPersistedMessage(manager), skill)) return;
	appendHistoryMessage(manager, skill);
}

/** Wrap a context handler so its trailing skill message is persisted too. */
export function hackContext(pi, handler) {
	return pi.on("context", (event, ctx) => {
		const result = handler(event, ctx);
		if (!result || typeof result !== "object" || !Array.isArray(result.messages)) return result;
		const skill = result.messages.at(-1);
		if (skill?.herdSkill === true) persistSkill(ctx?.sessionManager ?? null, skill);
		return result;
	});
}
