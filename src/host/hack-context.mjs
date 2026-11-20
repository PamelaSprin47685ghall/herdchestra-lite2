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

function lastPersistedMessage(manager) {
	const branch = typeof manager.getBranch === "function" ? manager.getBranch() : [];
	let last = null;
	for (const entry of branch ?? []) {
		if (entry?.type === "message" && entry.message) last = entry.message;
	}
	return last;
}

function isSkill(message) {
	return message?.herdSkill === true;
}

/**
 * Append the turn's skill receipt to the branch and the live transcript.
 *
 * `source` is what makes the three views agree: without it the receipt lands
 * on disk only, the provider never sees it in the request that produced it, and
 * the next turn replays a prefix that never existed for the cache. The receipt
 * also has to stay *one* message: the same turn can run the context handler
 * twice, and the clock line changes with the second, so text equality is not
 * an identity test. A trailing receipt means "nothing has been said since the
 * last one", and reusing it keeps the bytes -- timestamp included -- unchanged.
 */
function persistSkill(manager, skill, source = null) {
	if (!manager || typeof manager.appendMessage !== "function") return;
	if (isSkill(lastPersistedMessage(manager))) return;
	appendHistoryMessage(manager, skill, source);
}

/** Wrap a context handler so its trailing skill message is persisted too. */
export function hackContext(pi, handler, options = {}) {
	const managerFor =
		typeof options.managerFor === "function" ? options.managerFor : null;
	return pi.on("context", (event, ctx) => {
		const result = handler(event, ctx);
		if (!result || typeof result !== "object" || !Array.isArray(result.messages)) return result;
		const skill = result.messages.at(-1);
		if (skill?.herdSkill !== true) return result;
		// The station owns the journal this context belongs to. `ctx.sessionManager`
		// is whatever the host exposed for this session; on a flow that can be the
		// shared raw manager, whose leaf is another flow's. The station's manager
		// is the one the flow's own writes go through.
		let manager = null;
		if (managerFor) {
			try {
				manager = managerFor(ctx) ?? null;
			} catch {
				manager = null;
			}
		}
		persistSkill(manager ?? ctx?.sessionManager ?? null, skill, ctx);
		return result;
	});
}
