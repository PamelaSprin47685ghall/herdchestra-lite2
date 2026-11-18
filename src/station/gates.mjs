// Station gatekeepers: synchronous external-event entries. Each function
// translates one host event into state transitions and, at the tail, a ticket
// call through the station's injected capability bundle.

import {
	chargeTool,
	currentScope,
	truncateForHostBoundary,
} from "../scope/index.mjs";
import { appendUserTail, beatKey, toolCalls } from "../transcript/index.mjs";
import { READ_ONLY_SUBAGENT, READ_WRITE_SUBAGENT } from "../host/policy.mjs";
import { injectSystemPrompt, languageSkill } from "../host/prompts.mjs";
import {
	firstEvaluationNudge,
	invalidatePromotion,
	isTodoView,
	openLedgerNudge,
	relayStatusText,
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

function onToolCall(station, event, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	try {
		// Controls are processed before tool dispatch so scope executes can
		// read their cached result. A handoff-pending begin must be stopped
		// before that processing, or the scope would open despite the block.
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
			if (event.toolName === "scope") {
				const hasBegin = args.begin !== undefined && args.begin !== null;
				const hasEnd = args.end === true;
				if (hasBegin) {
					if (station.state.relay?.handoffPending) {
						return {
							block: true,
							reason:
								"RELAY_HANDOFF_PENDING: a relay handoff is pending. Do not open a new scope; wait for the successor.",
						};
					}
					if (station.state.relay?.canStop) {
						station.state.relay = invalidatePromotion(station.state.relay);
						station.persist();
					}
					// In hosts where `tool_call` runs before `assistant_message` /
					// persistence, opening a begin-only scope here ensures
					// subsequent tools in the same message see the new scope.
					if (!hasEnd && !station.handled.has(event.toolCallId)) {
						station.directScope(event.toolCallId, args);
					}
				}
			} else if (!station.handled.has(event.toolCallId)) {
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
		const beatTools = found
			? toolCalls(found.message).map((call) => call.name)
			: [];
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

function onContext(station, messages, ctx) {
	const original = Array.isArray(messages) ? messages : [];
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) {
		return {
			messages: appendUserTail(
				original,
				`<system-reminder>${languageSkill}</system-reminder>`,
			),
		};
	}
	station.ensureTools(ctx);
	const relayOn = station.relayOn(ctx);
	const boundaryKey = hostBoundaryKey(original);
	if (boundaryKey && boundaryKey !== station.hostBoundaryKey) {
		station.hostBoundaryKey = boundaryKey;
		truncateForHostBoundary(station.state);
		station.persist();
	}
	const relay = station.state.relay;
	const gen0FirstEmpty =
		relay?.generation === 0 &&
		relay?.firstEvaluation === "empty" &&
		relay?.lastLedger?.empty === true;
	if (relayOn && relay?.handoffPending && relay.lastLedger?.empty && !gen0FirstEmpty) {
		return station.tickets.contextHandoff(station, ctx, original);
	}
	return station.transformContext(original, ctx);
}

function onSessionStop(station, ctx) {
	if (!station.relayOn(ctx)) return undefined;
	if (station.sessionStopRunning) {
		return continueFeedback("A session_stop pass is already running; wait.");
	}
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
	if (station.handoffExecuting) station.advanceRelayForHandoff();
	station.persist();
}

function onSessionCompact(station, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return;
	truncateForHostBoundary(station.state);
	station.persist();
}

function onAutoCompactionEnd(station, event, ctx) {
	if (!isHandoffCompaction(event)) return;
	if (!station.handoffExecuting) return;
	station.advanceRelayForHandoff();
	station.persist();
}

function onBeforeAgentStart(station, event, ctx) {
	if (ctx?.model) station.lastCtxModel = ctx.model;
	const policy = station.policy(ctx);
	const prompt = injectSystemPrompt(event?.systemPrompt);
	const promptChanged = prompt !== event?.systemPrompt;
	// Relay and `todo` share one verdict: `ensureTools` owns that rule, so no
	// second `getActiveTools` check may live here.
	if (policy === READ_WRITE_SUBAGENT) station.ensureTools(ctx);
	if (!promptChanged) return undefined;
	return { systemPrompt: prompt };
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
