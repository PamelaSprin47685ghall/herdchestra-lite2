// Station gatekeepers: synchronous external-event entries. Each function
// translates one host event into state transitions and, at the tail, a ticket
// call through the station's injected capability bundle.

import {
	chargeTool,
	currentScope,
	truncateForHostBoundary,
} from "../scope/index.mjs";
import { beatKey, toolCalls } from "../transcript/index.mjs";
import { READ_ONLY_SUBAGENT, READ_WRITE_SUBAGENT } from "../host/policy.mjs";
import { injectSystemPrompt } from "../host/prompts.mjs";
import {
	firstEvaluationNudge,
	isTodoView,
	openLedgerNudge,
} from "../relay/index.mjs";
import { continueFeedback, isHandoffCompaction } from "../tools/results.mjs";
import {
	CONTROL_TOOLS,
	controlsIn,
	hostBoundaryKey,
	parseArgs,
} from "./messages.mjs";
import { insideScopeText } from "./texts.mjs";

function onAssistantMessage(station, message, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	try {
		station.onUsageMessage(message, ctx);
		station.preparingMessage = message;
		station.rememberCallGroups(message);
		station.processAssistantMessage(message, { persisted: false });
		station.maybeNudge(message, ctx);
	} catch (error) {
		station.lastError = String(error?.message ?? error);
	}
	return undefined;
}

function onMessageEnd(station, event, ctx) {
	if (event?.message?.role !== "assistant") return undefined;
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	const message = event.message;
	try {
		station.onUsageMessage(message, ctx);
		station.rememberCallGroups(message);
		const controls = controlsIn(message);
		if (controls.length > 0) {
			const found = station.assistantForToolCall(controls[0].id);
			station.processAssistantMessage(message, { persisted: Boolean(found) });
		}
		station.maybeNudge(message, ctx);
	} catch (error) {
		station.lastError = String(error?.message ?? error);
	}
	return undefined;
}

function onToolCall(station, event, ctx, atDispatch = false) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	try {
		// Reject a known pending handoff before asking for tool approval.
		// Scope also checks again at execution, after earlier calls finish.
		if (event.toolName === "scope" && station.state.relay?.handoffPending) {
			const args = parseArgs({
				arguments: event.input ?? event.arguments ?? {},
			});
			if (args.begin !== undefined && args.begin !== null) {
				return {
					block: true,
					reason:
						"RELAY_HANDOFF_PENDING: a relay handoff is pending. Do not open a new scope; wait for the successor.",
				};
			}
		}
		if (!atDispatch && station.deferScopePreflight(event.toolCallId, event.toolName)) {
			return undefined;
		}
		station.processControlsForTool(event.toolCallId);
		if (event.toolName === "todo") {
			if (currentScope(station.state)) {
				return {
					block: true,
					reason:
						"TODO_OUTSIDE_SCOPE_ONLY: todo is forbidden inside any active scope. Close every scope first; todo only works outside all scopes.",
				};
			}
			if (
				station.state.relay?.handoffPending &&
				!isTodoView(event.input ?? event.arguments ?? {})
			) {
				return {
					block: true,
					reason:
						"RELAY_HANDOFF_PENDING: a relay handoff is pending. A todo view is allowed for diagnosis; do not change the ledger.",
				};
			}
			station.persist();
			return undefined;
		}
		if (CONTROL_TOOLS.has(event.toolName)) {
			const args = parseArgs({
				arguments: event.input ?? event.arguments ?? {},
			});
			if (!station.handled.has(event.toolCallId)) {
				if (event.toolName === "regret") {
					station.directRegret(event.toolCallId, args);
				} else if (event.toolName === "defer") {
					station.directDefer(event.toolCallId, args);
				} else if (event.toolName === "pin") {
					station.directPin(event.toolCallId, args);
				}
			}
			return undefined;
		}
		if (!currentScope(station.state)) {
			return {
				block: true,
				reason:
					"Not in a scope. Outside all scopes only todo and the free control tools (scope, regret, defer, pin) may be called. Open a scope with scope({ begin: { intent, budget } }) before using any other tool.",
			};
		}
		const found = station.assistantForToolCall(event.toolCallId);
		if (found) station.rememberCallGroups(found.message);
		const groupKey =
			station.callGroups.get(event.toolCallId) ??
			(found ? beatKey(found.message) : undefined);
		const beatTools = toolCalls(found?.message ?? station.messageForToolCall(event.toolCallId))
			.map((call) => call.name);
		const charged = chargeTool(station.state, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			groupKey,
			beatTools,
		});
		if (!charged.ok) return { block: true, reason: charged.reason };
		station.persist();
		return undefined;
	} catch (error) {
		return {
			block: true,
			reason: `Scope accounting failed closed: ${String(error?.message ?? error)}`,
		};
	}
}

function observeHostBoundary(station, messages) {
	const boundaryKey = hostBoundaryKey(messages);
	if (!boundaryKey || boundaryKey === station.hostBoundaryKey) return;
	station.hostBoundaryKey = boundaryKey;
	truncateForHostBoundary(station.state);
	station.resetUsageWatermark();
	station.persist();
}

function onContext(station, messages, ctx) {
	const original = Array.isArray(messages) ? messages : [];
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return { messages: original };
	station.ensureTools(ctx);
	observeHostBoundary(station, original);
	station.observeActualModel(ctx);
	const restore = station.tickets.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	if (req) return restore(station, ctx, req, original, (messages) => station.withSkillReceipt(original, station.transformContext(messages, ctx), ctx));
	return station.withSkillReceipt(original, station.transformContext(original, ctx), ctx);
}

function onSessionStop(station, ctx) {
	if (!station.relayOn(ctx)) return undefined;
	if (station.handoffPromise) return undefined;
	const scope = currentScope(station.state);
	if (scope) return continueFeedback(insideScopeText(station.state));
	const relay = station.state.relay;
	if (!relay) return continueFeedback(firstEvaluationNudge());
	if (relay.canStop) return undefined;
	if (relay.handoffPending) {
		return station.tickets.sessionStop(station, ctx);
	}
	if (!relay.lastLedger) {
		return continueFeedback(firstEvaluationNudge());
	}
	// The empty ledger after a handoff belongs to the previous generation.
	// The successor must evaluate first; only its result can trigger the
	// next handoff.
	if (relay.generation > 0 && relay.firstEvaluation === null) {
		return continueFeedback(firstEvaluationNudge());
	}
	if (relay.lastLedger.empty) {
		station.armHandoff();
		return station.tickets.sessionStop(station, ctx);
	}
	return continueFeedback(openLedgerNudge(relay, relay.lastLedger));
}

function onSessionSwitch(station, event, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return;
	const reason = event?.reason ?? event?.handoffReason;
	if (reason !== "handoff" && event?.handoff !== true) return;
	truncateForHostBoundary(station.state);
	station.resetUsageWatermark();
	if (station.handoffExecuting) station.handoffSwitched = true;
	station.persist();
}

function onSessionCompact(station, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return;
	truncateForHostBoundary(station.state);
	station.hostBoundaryKey = hostBoundaryKey(station.contextMessages()) ?? station.hostBoundaryKey;
	station.resetUsageWatermark();
	station.persist();
	const restore = station.tickets.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	if (req) return restore(station, ctx, req);
}

function onAutoCompactionEnd(station, event, ctx) {
	if (!isHandoffCompaction(event)) return;
	if (!station.handoffExecuting) return;
	station.handoffSwitched = true;
}

function onBeforeAgentStart(station, event, ctx) {
	const policy = station.policy(ctx);
	const prompt = injectSystemPrompt(event?.systemPrompt);
	const promptChanged = prompt !== event?.systemPrompt;
	// Relay and `todo` share one verdict: `ensureTools` owns that rule, so no
	// second `getActiveTools` check may live here.
	if (policy === READ_WRITE_SUBAGENT) station.ensureTools(ctx);
	const result = promptChanged ? { systemPrompt: prompt } : undefined;
	if (policy === READ_ONLY_SUBAGENT) return result;
	// The host selects the provider model before it calls the context hook.
	observeHostBoundary(station, station.contextMessages());
	station.observeActualModel(ctx);
	const restore = station.tickets.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	if (req) return restore(station, ctx, req, result);
	return result;
}

export {
	onAssistantMessage,
	onMessageEnd,
	onToolCall,
	onContext,
	onSessionStop,
	onSessionSwitch,
	onSessionCompact,
	onAutoCompactionEnd,
	onBeforeAgentStart,
};
