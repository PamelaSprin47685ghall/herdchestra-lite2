// Station execute cores. Structural control calls mutate one ledger.

import { errorResult } from "../tools/results.mjs";
import { lastStructuralCallId } from "../transcript/index.mjs";
import { handoffToolBlockedReason } from "../relay/index.mjs";
import { MAIN_AGENT } from "../host/policy.mjs";
import { handlePinCall, handleAmendCall } from "./controls.mjs";
import { handleForkCall, handleJoinCall, handleReturnCall } from "./fork-controls.mjs";

/**
 * Run one control tool through the processed-id cache.
 *
 * A control call may already have been answered while its assistant message
 * was scanned. Both lookups are the same question asked on either side of that
 * scan, so every control tool shares this order instead of repeating it.
 */
function withProcessedCache(station, toolCallId, direct) {
	const cached = station.processed.handledFor(toolCallId);
	if (cached) return cached;
	station.processControlsForTool(toolCallId);
	const processed = station.processed.handledFor(toolCallId);
	if (processed) return processed;
	return direct();
}

function executeAmend(station, toolCallId, params) {
	return withProcessedCache(station, toolCallId, () =>
		directAmend(station, toolCallId, params));
}

function executePin(station, toolCallId, params) {
	const cached = station.processed.handledFor(toolCallId);
	if (cached) return cached;
	const ownerId =
		typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
	if (ownerId === null && station.state.autopilot && station.state.relay?.handoffPending) {
		return errorResult("RELAY_HANDOFF_PENDING", handoffToolBlockedReason());
	}
	const result = handlePinCall(station, { id: toolCallId, arguments: params });
	station.processed.setHandled(toolCallId, result);
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
		const cached = station.processed.handledFor(toolCallId);
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
	station.processed.setHandled(toolCallId, result);
	station.processed.markCall(toolCallId);
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
	const cached = station.processed.handledFor(toolCallId);
	if (cached) return cached;
	const result = direct();
	// A retryable answer is not a final one: the ticket waits and calls again.
	// Caching it here would make the wait loop read its own stale refusal.
	const retry = typeof options.retryWhen === "function" && options.retryWhen(result);
	if (!retry) {
		station.processed.setHandled(toolCallId, result);
		station.processed.markCall(toolCallId);
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
		const { currentMessage } = controlContext(station, toolCallId);
		return handleForkCall(
			station,
			{ id: toolCallId, name: "scope_fork", arguments: params },
			{
				ctx,
				currentMessage,
				mainAgent: station.policy(ctx) === MAIN_AGENT,
				// Manual duty runs no relay. A relay left behind by an earlier
				// autopilot handoff must not keep gatekeeping fork admission.
				relayOn: station.state.autopilot === true && station.relayOn(ctx),
			},
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

function executeReturn(station, toolCallId, params, ctx) {
	return executeControl(
		station,
		toolCallId,
		() => {
			const { currentMessage } = controlContext(station, toolCallId);
			return handleReturnCall(
				station,
				{ id: toolCallId, name: "scope_return", arguments: params },
				{ ctx, currentMessage },
			);
		},
		// The queued record is not yet accepted. Only the parent's join makes
		// it final, so the ticket must be free to call this again after it.
		{ retryWhen: (result) => result?.details?.awaitingReceipt === true },
	);
}

export {
	executeAmend,
	executePin,
	executeFork,
	executeJoin,
	executeReturn,
	directAmend,
};
