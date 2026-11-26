/**
 * Tool-call ledger: the per-session idempotence state that used to live
 * directly on SessionStation. The station delegates here; it no longer owns a
 * request table.
 *
 * With one `js` tool the dispatch tracker lost its last client: a beat's
 * structural effects are recorded by the js ticket itself, so the station keeps
 * only the processed set.
 *
 * Plain synchronous state, no host import, no station import. The accessor
 * tolerates the older unit doubles that still pass `processed` directly to a
 * free function; production stations only use the ledger object.
 */

import { createProcessedLedger } from "../processed-ledger.mjs";

export function createToolCallLedger() {
	const processed = createProcessedLedger();

	return {
		processed,

		handledFor(toolCallId) {
			return processed.handledFor(toolCallId);
		},
		hasHandled(toolCallId) {
			return processed.hasHandled(toolCallId);
		},
		setHandled(toolCallId, result) {
			processed.setHandled(toolCallId, result);
		},
		markCall(toolCallId) {
			processed.markCall(toolCallId);
		},
		hasCall(toolCallId) {
			return processed.hasCall(toolCallId);
		},
		markMessage(key) {
			processed.markMessage(key);
		},
		hasMessage(key) {
			return processed.hasMessage(key);
		},
	};
}

/** The processed ledger for a real station or a legacy plain test double. */
export function processedOf(station) {
	return station?.toolCallLedger?.processed ?? station?.processed ?? null;
}
