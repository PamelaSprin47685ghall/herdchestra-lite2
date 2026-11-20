/**
 * Processed ledger: the idempotence caches that keep one tool call or one
 * assistant message from being handled twice.
 *
 * These three collections change for one reason — the host may deliver the
 * same event more than once — so they own their bounds here instead of being
 * scattered across the station. Pure synchronous state; no I/O.
 */

const HANDLED_LIMIT = 512;

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
			calls.add(toolCallId);
		},

		hasCall(toolCallId) {
			return calls.has(toolCallId);
		},

		markMessage(key) {
			messages.add(key);
		},

		hasMessage(key) {
			return messages.has(key);
		},
	};
}
