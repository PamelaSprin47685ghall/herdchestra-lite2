// Station execute cores: the synchronous results a control tool returns.
// These run after the assistant-message hook has already cached a result.

import { findToolCallIndex } from "../transcript/index.mjs";
import { errorResult } from "../tools/results.mjs";
import {
	handleDeferCall,
	handlePinCall,
	handleRegretCall,
	handleScopeCall,
} from "./controls.mjs";
import { controlsIn, parseArgs } from "./messages.mjs";

function executeScope(station, toolCallId, params) {
	const cached = station.handled.get(toolCallId);
	if (cached) return cached;
	station.processControlsForTool(toolCallId);
	const processed = station.handled.get(toolCallId);
	if (processed) return processed;
	return directScope(station, toolCallId, params);
}

function executeRegret(station, toolCallId, params) {
	const cached = station.handled.get(toolCallId);
	if (cached) return cached;
	station.processControlsForTool(toolCallId);
	const processed = station.handled.get(toolCallId);
	if (processed) return processed;
	return directRegret(station, toolCallId, params);
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
	station.processControlsForTool(toolCallId);
	const processed = station.handled.get(toolCallId);
	if (processed) return processed;
	return directPin(station, toolCallId, params);
}

function directScope(station, toolCallId, params) {
	const found = station.assistantForToolCall(toolCallId);
	if (found) {
		station.processAssistantMessage(found.message, { persisted: true });
		const cached = station.handled.get(toolCallId);
		if (cached) return cached;
	}
	const base = found?.messages ?? station.contextMessages();
	const currentMessage = found?.message ?? { role: "assistant", content: [], timestamp: Date.now() };
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
	});
	station.setHandled(toolCallId, result);
	station.processedCalls.add(toolCallId);
	station.persist();
	return result;
}

function directRegret(station, toolCallId, params) {
	const found = station.assistantForToolCall(toolCallId);
	if (found) {
		station.processAssistantMessage(found.message, { persisted: true });
		const cached = station.handled.get(toolCallId);
		if (cached) return cached;
	}
	const base = found?.messages ?? station.contextMessages();
	const index = found ? found.index : base.length;
	if (index <= 0 && !found) {
		return errorResult("NOT_IN_SCOPE", "regret is only allowed inside a scope with a visible beat history.");
	}
	const result = handleRegretCall(
		station,
		{ id: toolCallId, name: "regret", arguments: params },
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

function directPin(station, toolCallId, params) {
	const found = station.assistantForToolCall(toolCallId);
	if (found) {
		station.processAssistantMessage(found.message, { persisted: true });
		const cached = station.handled.get(toolCallId);
		if (cached) return cached;
	}
	const result = handlePinCall();
	station.setHandled(toolCallId, result);
	station.processedCalls.add(toolCallId);
	return result;
}

export {
	executeScope,
	executeRegret,
	executeDefer,
	executePin,
	directScope,
	directRegret,
	directDefer,
	directPin,
};
