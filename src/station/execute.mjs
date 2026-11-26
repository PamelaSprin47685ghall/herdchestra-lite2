// Station execute cores. Structural control calls mutate one ledger.
//
// Only the five scope primitives remain. Ordinary work is a host tool reached
// through the js runtime, so it never passes through this module.
//
// Two ids arrive with every control call. `toolCallId` is the call's own id,
// unique in the ledger and in the cache; inside one `js` script it is
// synthetic (`<frameId>#<index>`). `frameId` is the assistant tool call the
// journal knows, and it is what every journal lookup must read.

import { handleAbandonCall, handleForkCall, handleJoinCall, handleReturnCall } from "./fork-controls.mjs";
import { processedOf } from "./domain/tool-call-ledger.mjs";

/**
 * The assistant message that carries this control call.
 *
 * Fork/join/return all need it: the first to know its depth, the last two to
 * refuse a call that is not last in its message.
 */
function controlContext(station, frameId) {
	// One lookup: `messageForToolCall` is the same `assistantForToolCall` call,
	// so a fallback to it could only ever re-answer null.
	const found = station.assistantForToolCall(frameId);
	return { found, currentMessage: found?.message ?? null };
}

function executeControl(station, toolCallId, direct, options = {}) {
	const cached = processedOf(station).handledFor(toolCallId);
	if (cached) return cached;
	const result = direct();
	// A retryable answer is not a final one: the ticket waits and calls again.
	// Caching it here would make the wait loop read its own stale refusal.
	const retry = typeof options.retryWhen === "function" && options.retryWhen(result);
	if (!retry) {
		processedOf(station).setHandled(toolCallId, result);
		processedOf(station).markCall(toolCallId);
		if (station.persist() === false) {
			station.noteError?.("persist", new Error("control state write failed"), {
				toolCallId,
			});
		}
	}
	return result;
}

function executeFork(station, toolCallId, params, ctx, frameId = null) {
	const frame = frameId ?? toolCallId;
	return executeControl(station, toolCallId, () => {
		controlContext(station, frame);
		return handleForkCall(
			station,
			{ id: toolCallId, frameId: frame, name: "scope_fork", arguments: params },
			{ ctx },
		);
	});
}

function executeJoin(station, toolCallId, params, ctx, frameId = null) {
	const frame = frameId ?? toolCallId;
	return executeControl(
		station,
		toolCallId,
		() => {
			const { currentMessage } = controlContext(station, frame);
			return handleJoinCall(
				station,
				{ id: toolCallId, frameId: frame, name: "scope_join", arguments: params },
				{ ctx, currentMessage },
			);
		},
		{ retryWhen: (result) => result?.details?.code === "NO_READY_CHILD" },
	);
}

/**
 * Close the bracket and answer in the same beat. The record is sealed for the
 * parent to take whenever it joins; nothing is left parked.
 */
function executeReturn(station, toolCallId, params, ctx, frameId = null) {
	const frame = frameId ?? toolCallId;
	return executeControl(station, toolCallId, () => {
		const { currentMessage } = controlContext(station, frame);
		return handleReturnCall(
			station,
			{ id: toolCallId, frameId: frame, name: "scope_return", arguments: params },
			{ ctx, currentMessage },
		);
	});
}

/**
 * Close a child that will not return. The station closes the bracket and
 * settles everything that waits on it; nothing parks here.
 */
function executeAbandon(station, toolCallId, params, ctx) {
	return executeControl(station, toolCallId, () =>
		handleAbandonCall(
			station,
			{ id: toolCallId, name: "scope_abandon", arguments: params },
			{ ctx },
		),
	);
}

export { executeAbandon, executeFork, executeJoin, executeReturn };
