/**
 * Processed ledger: the idempotence caches that keep one tool call or one
 * assistant message from being handled twice.
 *
 * These three collections change for one reason — the host may deliver the
 * same event more than once — so they own their bounds here instead of being
 * scattered across the station. Pure synchronous state; no I/O.
 */

const HANDLED_LIMIT = 512;
const CALL_LIMIT = 512;
const MESSAGE_LIMIT = 512;

/**
 * Remember one id in a bounded ring. Re-seeing an id refreshes it to the
 * newest position, so the ids the host keeps repeating are never evicted
 * while a stale one falls out first.
 */
function remember(set, id, limit) {
	set.delete(id);
	set.add(id);
	if (set.size > limit) {
		const oldest = set.values().next().value;
		set.delete(oldest);
	}
}

function seen(set, id) {
	if (!set.has(id)) return false;
	set.delete(id);
	set.add(id);
	return true;
}

export function createProcessedLedger() {
	const handled = new Map();
	const calls = new Set();
	const messages = new Set();

	return {
		handledFor(toolCallId) {
			return handled.get(toolCallId);
		},

		hasHandled(toolCallId) {
			return handled.has(toolCallId);
		},

		setHandled(toolCallId, result) {
			handled.set(toolCallId, result);
			if (handled.size > HANDLED_LIMIT) {
				const oldest = handled.keys().next().value;
				handled.delete(oldest);
			}
		},

		markCall(toolCallId) {
			remember(calls, toolCallId, CALL_LIMIT);
		},

		hasCall(toolCallId) {
			return seen(calls, toolCallId);
		},

		markMessage(key) {
			remember(messages, key, MESSAGE_LIMIT);
		},

		hasMessage(key) {
			return seen(messages, key);
		},
	};
}
