// Station execute cores. Structural control calls mutate one ledger.

import { errorResult, textResult } from "../tools/results.mjs";
import { lastStructuralCallId } from "../transcript/index.mjs";
import { handlePinCall, handleAmendCall } from "./controls.mjs";
import { handleForkCall, handleJoinCall, handleReturnCall } from "./fork-controls.mjs";
import { handleSendCall } from "./send-controls.mjs";
import { processedOf } from "./domain/tool-call-ledger.mjs";

/**
 * Run one control tool through the processed-id cache.
 *
 * A control call may already have been answered while its assistant message
 * was scanned. Both lookups are the same question asked on either side of that
 * scan, so every control tool shares this order instead of repeating it.
 */
function withProcessedCache(station, toolCallId, direct) {
	const cached = processedOf(station).handledFor(toolCallId);
	if (cached) return cached;
	station.processControlsForTool(toolCallId);
	const processed = processedOf(station).handledFor(toolCallId);
	if (processed) return processed;
	return direct();
}

function executeAmend(station, toolCallId, params) {
	return withProcessedCache(station, toolCallId, () =>
		directAmend(station, toolCallId, params));
}

function executePin(station, toolCallId, params) {
	const cached = processedOf(station).handledFor(toolCallId);
	if (cached) return cached;
	const result = handlePinCall(station, { id: toolCallId, arguments: params });
	processedOf(station).setHandled(toolCallId, result);
	return result;
}

/**
 * One control call that may carry both a note and an amend. Both halves are
 * synchronous station work; the ticket only chose this entry point. A host
 * retry of the outer id must not repeat either half, so the amend half reads
 * the result the direct-amend path may already have cached under that id.
 */
function executeContext(station, toolCallId, params) {
	const cached = processedOf(station).handledFor(toolCallId);
	if (cached?.details?.scopeContext === true) return cached;
	const amendParams = params?.amend;
	const pinParams = params?.pin;
	// A single-half call that a previous delivery already answered returns
	// that answer: the direct-amend path caches under this same id, and the
	// half's own execute caches under its derived id.
	if (cached && (amendParams === undefined) !== (pinParams === undefined)) {
		return cached;
	}
	const amend = amendParams === undefined
		? null
		: cached ?? station.executeAmend(`${toolCallId}#amend`, amendParams);
	const pin = pinParams === undefined
		? null
		: station.executePin(`${toolCallId}#pin`, pinParams);
	if (amend === null || pin === null) {
		const single = amend ?? pin;
		processedOf(station).setHandled(toolCallId, single);
		return single;
	}
	const failed = amend.isError === true || pin.isError === true;
	const text = [amend, pin]
		.map((result) => result.content?.[0]?.text ?? "")
		.join("\n\n");
	const result = failed
		? errorResult("scope_context-partial", text, {
			scopeContext: true,
			amend: amend.details,
			pin: pin.details,
		})
		: textResult(text, { scopeContext: true, amend: amend.details, pin: pin.details });
	processedOf(station).setHandled(toolCallId, result);
	return result;
}

/**
 * The boundary an amend may reach: the branch's most recent structural call,
 * or the transcript start when the branch has made none. The ledger and owner
 * travel with it so a refund lands on exactly this branch.
 */
function amendBoundary(station, currentMessage, currentIndex, messages) {
	const ledger =
		typeof station.forkLedgerPort === "function" ? station.forkLedgerPort() : null;
	const ownerId =
		typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
	const base = Array.isArray(messages) ? messages : station.contextMessages?.() ?? [];
	return {
		ownerId,
		ledger,
		afterToolCallId: lastStructuralCallId(base, currentIndex) ?? null,
		record:
			ownerId && ledger
				? (ledger.forks?.[ownerId] ?? null)
				: null,
	};
}

function directAmend(station, toolCallId, params) {
	const found = station.assistantForToolCall(toolCallId);
	if (found) {
		station.processAssistantMessage(found.message);
		const cached = processedOf(station).handledFor(toolCallId);
		if (cached) return cached;
	}
	const base = found?.messages ?? station.contextMessages();
	const index = found ? found.index : base.length;
	const boundary = amendBoundary(
		station,
		found?.message ?? station.messageForToolCall(toolCallId) ?? null,
		index,
		base,
	);
	const result = handleAmendCall(
		station,
		{ id: toolCallId, name: "amend", arguments: params },
		base,
		index,
		boundary,
	);
	processedOf(station).setHandled(toolCallId, result);
	processedOf(station).markCall(toolCallId);
	station.persist();
	return result;
}

/**
 * The assistant message that carries this control call, with its persisted
 * state brought up to date. Fork/join/return all need it: the first to know
 * its depth, the last two to refuse a call that is not last in its message.
 */
function controlContext(station, toolCallId) {
	const found = station.assistantForToolCall(toolCallId);
	if (found) station.processAssistantMessage(found.message);
	const currentMessage =
		found?.message ?? station.messageForToolCall(toolCallId) ?? null;
	return { found, currentMessage };
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

function executeFork(station, toolCallId, params, ctx) {
	return executeControl(station, toolCallId, () => {
		// Refresh the carrying assistant message before admission.
		controlContext(station, toolCallId);
		return handleForkCall(
			station,
			{ id: toolCallId, name: "scope_fork", arguments: params },
			{ ctx },
		);
	});
}

function executeJoin(station, toolCallId, params, ctx) {
	return executeControl(
		station,
		toolCallId,
		() => {
			const { currentMessage } = controlContext(station, toolCallId);
			return handleJoinCall(
				station,
				{ id: toolCallId, name: "scope_join", arguments: params },
				{ ctx, currentMessage },
			);
		},
		{ retryWhen: (result) => result?.details?.code === "NO_READY_CHILD" },
	);
}

/**
 * Close the bracket and answer in the same beat. The record is sealed for the
 * parent to take whenever it joins; nothing is left parked, so a woken scope
 * can be talked to instead of blocked inside a tool call.
 */
function executeReturn(station, toolCallId, params, ctx) {
	return executeControl(station, toolCallId, () => {
		const { currentMessage } = controlContext(station, toolCallId);
		return handleReturnCall(
			station,
			{ id: toolCallId, name: "scope_return", arguments: params },
			{ ctx, currentMessage },
		);
	});
}

/** One message addressed by path. Synchronous: every write lands before the wake. */
function executeSend(station, toolCallId, params, ctx) {
	return executeControl(station, toolCallId, () =>
		handleSendCall(
			station,
			{ id: toolCallId, name: "scope_send", arguments: params },
			ctx,
		));
}

export {
	executeAmend,
	executePin,
	executeContext,
	executeFork,
	executeJoin,
	executeReturn,
	executeSend,
	directAmend,
};
