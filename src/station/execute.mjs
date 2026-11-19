// Station execute cores. Scope changes happen only at the execution barrier.

import { findToolCallIndex } from "../transcript/index.mjs";
import { handoffToolBlockedReason } from "../relay/index.mjs";
import { errorResult } from "../tools/results.mjs";
import {
	handleDeferCall,
	handlePinCall,
	handleAmendCall,
	handleScopeCall,
} from "./controls.mjs";
import { controlsIn, parseArgs } from "./messages.mjs";

function executeScope(station, toolCallId, params, ctx) {
	const cached = station.handled.get(toolCallId);
	if (cached) return cached;
	station.processControlsForTool(toolCallId);
	const processed = station.handled.get(toolCallId);
	if (processed) return processed;
	return directScope(station, toolCallId, params, ctx);
}

function executeAmend(station, toolCallId, params) {
	const cached = station.handled.get(toolCallId);
	if (cached) return cached;
	station.processControlsForTool(toolCallId);
	const processed = station.handled.get(toolCallId);
	if (processed) return processed;
	return directAmend(station, toolCallId, params);
}

function executeDefer(station, toolCallId, params) {
	const cached = station.handled.get(toolCallId);
	if (cached) return cached;
	station.processControlsForTool(toolCallId);
	const processed = station.handled.get(toolCallId);
	if (processed) return processed;
	return directDefer(station, toolCallId, params);
}

function executePin(station, toolCallId, params) {
	const cached = station.handled.get(toolCallId);
	if (cached) return cached;
	if (!station.state.herdMode && station.state.relay?.handoffPending) {
		return errorResult("RELAY_HANDOFF_PENDING", handoffToolBlockedReason());
	}
	const result = handlePinCall(station, { id: toolCallId, arguments: params });
	station.setHandled(toolCallId, result);
	return result;
}

function directScope(station, toolCallId, params, ctx) {
	const found = station.assistantForToolCall(toolCallId);
	if (found) {
		station.processAssistantMessage(found.message, { persisted: true });
		const cached = station.handled.get(toolCallId);
		if (cached) return cached;
	}
	const currentMessage = found?.message ?? station.messageForToolCall(toolCallId)
		?? { role: "assistant", content: [], timestamp: Date.now() };
	const base = found?.messages ?? [...station.contextMessages(), currentMessage];
	const controls = currentMessage.role === "assistant" ? controlsIn(currentMessage) : [];
	const beginIds = new Set(
		controls
			.filter((call) => call.name === "scope" && parseArgs(call).begin != null)
			.map((call) => call.id),
	);
	const call = { id: toolCallId, name: "scope", arguments: params };
	const result = handleScopeCall(station, call, {
		base,
		currentMessage,
		currentPersisted: Boolean(found),
		sameMessageBeginIds: beginIds,
		ctx,
	});
	station.setHandled(toolCallId, result);
	station.processedCalls.add(toolCallId);
	station.persist();
	return result;
}

function directAmend(station, toolCallId, params) {
	const found = station.assistantForToolCall(toolCallId);
	if (found) {
		station.processAssistantMessage(found.message, { persisted: true });
		const cached = station.handled.get(toolCallId);
		if (cached) return cached;
	}
	const base = found?.messages ?? station.contextMessages();
	const index = found ? found.index : base.length;
	if (index <= 0 && !found) {
		return errorResult("NOT_IN_SCOPE", "amend is only allowed inside a scope with a visible beat history.");
	}
	const result = handleAmendCall(
		station,
		{ id: toolCallId, name: "amend", arguments: params },
		base,
		index,
	);
	station.setHandled(toolCallId, result);
	station.processedCalls.add(toolCallId);
	station.persist();
	return result;
}

function directDefer(station, toolCallId, params) {
	const found = station.assistantForToolCall(toolCallId);
	if (found) {
		station.processAssistantMessage(found.message, { persisted: true });
		const cached = station.handled.get(toolCallId);
		if (cached) return cached;
	}
	const result = handleDeferCall(station, { id: toolCallId, name: "defer", arguments: params });
	station.setHandled(toolCallId, result);
	station.processedCalls.add(toolCallId);
	station.persist();
	return result;
}

export {
	executeScope,
	executeAmend,
	executeDefer,
	executePin,
	directScope,
	directAmend,
	directDefer,
};
