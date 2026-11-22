/**
 * Tool-call ledger: the per-session idempotence and in-flight state that used
 * to live directly on SessionStation. The station delegates here; it no
 * longer owns a request table.
 *
 * Plain synchronous state, no host import, no station import. The two
 * accessors tolerate the older unit doubles that still pass `processed` or
 * `dispatch` directly to a free function; production stations only use the
 * ledger object.
 */

import { createDispatchTracker } from "../dispatch-tracker.mjs";
import { createProcessedLedger } from "../processed-ledger.mjs";

const GATE_LIMIT = 512;

export function createToolCallLedger() {
	const processed = createProcessedLedger();
	const dispatch = createDispatchTracker();
	const toolGate = new Map();

	return {
		processed,
		dispatch,
		toolGate,

		// -- processed ledger -------------------------------------------------
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

		// -- dispatch tracker -------------------------------------------------
		setPreparing(message) {
			dispatch.setPreparing(message);
		},
		groupKeyFor(toolCallId) {
			return dispatch.groupKeyFor(toolCallId);
		},
		rememberGroups(message) {
			dispatch.rememberGroups(message);
		},
		prepare(message, toolCallId, name) {
			dispatch.prepare(message, toolCallId, name);
		},
		messageForToolCall(toolCallId) {
			return dispatch.messageForToolCall(toolCallId);
		},

		// -- tool-call gate cache --------------------------------------------
		toolGateVerdict(toolCallId) {
			if (!toolGate.has(toolCallId)) return { hit: false };
			const verdict = toolGate.get(toolCallId);
			// Refresh the entry so the cache evicts the least recently seen
			// call, not the call that was repeated.
			toolGate.delete(toolCallId);
			toolGate.set(toolCallId, verdict);
			return { hit: true, verdict };
		},
		rememberToolGate(toolCallId, verdict) {
			toolGate.delete(toolCallId);
			toolGate.set(toolCallId, verdict);
			if (toolGate.size > GATE_LIMIT) {
				const oldest = toolGate.keys().next().value;
				toolGate.delete(oldest);
			}
		},
	};
}

/** The processed ledger for a real station or a legacy plain test double. */
export function processedOf(station) {
	return station?.toolCallLedger?.processed ?? station?.processed ?? null;
}

/** The dispatch tracker for a real station or a legacy plain test double. */
export function dispatchOf(station) {
	return station?.toolCallLedger?.dispatch ?? station?.dispatch ?? null;
}
