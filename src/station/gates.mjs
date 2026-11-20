// Station gatekeepers: synchronous external-event entries. Each function
// translates one host event into state transitions and, at the tail, a ticket
// call through the station's injected capability bundle.

import {
	chargeTool,
	currentScope,
	effectiveDeadline,
	isFreeCall,
	truncateForHostBoundary,
} from "../scope/index.mjs";
import { DECISION_FRAMING } from "../scope/stages.mjs";
import { beatKey, toolCalls } from "../transcript/index.mjs";
import { READ_ONLY_SUBAGENT, READ_WRITE_SUBAGENT } from "../host/policy.mjs";
import { injectSystemPrompt } from "../host/prompts.mjs";
import {
	firstEvaluationNudge,
	handoffEmptyReportNudge,
	handoffToolBlockedReason,
	openLedgerNudge,
	successorStartNudge,
} from "../relay/index.mjs";
import { continueFeedback } from "../tools/results.mjs";
import { ownerRetirement } from "./retirement.mjs";
import {
	CONTROL_TOOLS,
	controlsIn,
	hostBoundaryKey,
	parseArgs,
} from "./messages.mjs";
import { insideScopeText } from "./texts.mjs";

function onAssistantMessage(station, message, ctx) {
	if (!station.fissionFlow && station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	try {
		station.onUsageMessage(message, ctx);
		station.dispatch.setPreparing(message);
		station.dispatch.rememberGroups(message);
		station.processAssistantMessage(message, { persisted: false });
		if (!station.state.herdMode && !currentScope(station.state) &&
			station.state.relay?.handoffPending && toolCalls(message).length === 0) {
			const text = message?.content
				?.filter((block) => block?.type === "text")
				.map((block) => block.text)
				.join("\n") ?? "";
			station.captureHandoffReport(text);
		}
		station.maybeNudge(message, ctx);
	} catch (error) {
		station.lastError = String(error?.message ?? error);
	}
	return undefined;
}

function onMessageEnd(station, event, ctx) {
	if (event?.message?.role !== "assistant") return undefined;
	if (!station.fissionFlow && station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	const message = event.message;
	try {
		station.onUsageMessage(message, ctx);
		station.dispatch.rememberGroups(message);
		const controls = controlsIn(message);
		if (controls.length > 0) {
			const found = station.assistantForToolCall(controls[0].id);
			station.processAssistantMessage(message, { persisted: Boolean(found) });
		}
		if (!station.state.herdMode && !currentScope(station.state) &&
			station.state.relay?.handoffPending && toolCalls(message).length === 0) {
			const text = message?.content
				?.filter((block) => block?.type === "text")
				.map((block) => block.text)
				.join("\n") ?? "";
			station.captureHandoffReport(text);
		}
		station.maybeNudge(message, ctx);
	} catch (error) {
		station.lastError = String(error?.message ?? error);
	}
	return undefined;
}

function onToolCall(station, event, ctx, atDispatch = false) {
	const { toolName, toolCallId } = event;
	// A retired fission owner may still have a started or queued turn. Its
	// identity decides: flows and an adopted heir hold other identities or
	// other stations, so only the retired owner is refused here.
	const retirement = ownerRetirement(station, ctx);
	if (retirement) return { block: true, reason: retirement.reason };
	if (station.fissionFlow && toolName === "amend") {
		return { block: true, reason: "AMEND_UNAVAILABLE_IN_FISSION: amend can overwrite another flow's shared history." };
	}
	if (station.fissionFlow?.permission === "ro" &&
		(toolName === "edit" || toolName === "write" || toolName === "bash" || toolName === "ast_edit")) {
		return { block: true, reason: "READ_ONLY_FLOW: this tool can change files and is unavailable in a read-only flow." };
	}
	// A flow may declare completion or delegate to a nested batch. The
	// scheduler writes the boundaries after the corresponding tool result.
	// The deferred admission call carries no arguments, so only the preflight
	// call can judge the shape; dispatch already passed this gate once.
	if (!atDispatch && station.fissionFlow && toolName === "scope") {
		const args = parseArgs({ arguments: event.input ?? event.arguments ?? {} });
		const begin = args?.begin;
		const nestedBegin = begin !== null && typeof begin === "object" &&
			!Array.isArray(begin) && Object.hasOwn(begin, "fission");
		if (!(args.end === true && !begin) && !nestedBegin) {
			return {
				block: true,
				reason:
					"SCOPE_UNAVAILABLE_IN_FISSION: Use scope({ end: true }) to finish the flow, or open a nested fission batch.",
			};
		}
	}
	if (!station.fissionFlow && station.policy(ctx) === READ_ONLY_SUBAGENT && toolName !== "ask" && toolName !== "wait") {
		return undefined;
	}
	try {
		const state = station.state;
		const scope = currentScope(state);
		// A resumed handoff can have a scope left open from herd mode. Let it
		// close before blocking all tools; handleScopeCall still refuses begin.
		if (!state.herdMode && state.relay?.handoffPending && !(scope && toolName === "scope")) {
			return {
				block: true,
				reason: handoffToolBlockedReason(),
			};
		}
		if (!atDispatch && station.deferScopePreflight(toolCallId, toolName)) {
			return undefined;
		}
		station.processControlsForTool(toolCallId);
		if (toolName === "todo") {
			if (scope) {
				return {
					block: true,
					reason:
						"TODO_OUTSIDE_SCOPE_ONLY: todo is forbidden inside any active scope. Close every scope first; todo only works outside all scopes.",
				};
			}
			station.persist();
			return undefined;
		}
		if (CONTROL_TOOLS.has(toolName)) {
			const args = parseArgs({
				arguments: event.input ?? event.arguments ?? {},
			});
			if (!station.processed.hasHandled(toolCallId)) {
				if (toolName === "amend") {
					station.directAmend(toolCallId, args);
				} else if (toolName === "defer") {
					station.directDefer(toolCallId, args);
				}
			}
			return undefined;
		}
		if (toolName === "ask") {
			if (state.herdMode && scope?.stage === DECISION_FRAMING) return undefined;
			return {
				block: true,
				reason: 'ask is allowed only when the user has enabled /herd and the current scope has stage: "decision-framing".',
			};
		}
		if (!scope) {
			return {
				block: true,
				reason:
					"Not in a scope. Outside all scopes only todo and the free control tools (scope, amend, defer, pin) may be called. Open a scope with scope({ begin: { stage, elder_report, fission: [{ intent, budget, permission }] } }); one flow is a one-item fission array, and every item must declare permission.",
			};
		}
		const deadline = effectiveDeadline(state);
		if (deadline !== null && Date.now() >= deadline && scope.overtimeAt === null) {
			scope.overtimeAt = Date.now();
		}
		if (toolName === "wait") return undefined;
		const found = station.assistantForToolCall(toolCallId);
		if (found) station.dispatch.rememberGroups(found.message);
		const groupKey =
			station.dispatch.groupKeyFor(toolCallId) ??
			(found ? beatKey(found.message) : undefined);
		const input = event.input ?? event.arguments ?? {};
		const beatTools = toolCalls(found?.message ?? station.messageForToolCall(toolCallId))
			.map((call) => ({
				name: call.name,
				free: isFreeCall(call.name, call.arguments),
			}));
		const charged = chargeTool(state, {
			toolCallId,
			toolName,
			groupKey,
			beatTools,
			input,
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
	if (station.fissionFlow) {
		if (station.fissionFlow.endRequested || station.pendingFission?.retired) return undefined;
		return continueFeedback("Your flow is still open. When your work is complete, call scope({ end: true }).");
	}
	if (station.state.herdMode) return undefined;
	if (!station.relayOn(ctx)) return undefined;
	const scope = currentScope(station.state);
	if (scope) return continueFeedback(insideScopeText(station.state));
	const relay = station.state.relay;
	if (!relay) return continueFeedback(firstEvaluationNudge());
	// A task that never opened a todo ledger is not in the full flow: no
	// handoff, no first-evaluation debt, no ledger debt.
	if (relay.fullFlow !== true) return undefined;
	if (relay.canStop) return undefined;
	if (relay.handoffPending) {
		if (station.handoffReport) {
			const committed = station.commitSelfHandoff(ctx, station.handoffReport);
			if (committed.ok) return continueFeedback(successorStartNudge(committed.relay));
		}
		return continueFeedback(handoffEmptyReportNudge());
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
		station.armHandoff(ctx);
		return continueFeedback(handoffEmptyReportNudge());
	}
	return continueFeedback(openLedgerNudge(relay, relay.lastLedger));
}

function onSessionSwitch(station, event, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return;
	const reason = event?.reason ?? event?.handoffReason;
	if (reason !== "handoff" && event?.handoff !== true) return;
	truncateForHostBoundary(station.state);
	station.resetUsageWatermark();
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

function onHerdCommand(station, args) {
	station.state.herdMode = !station.state.herdMode;
	station.persist();
	const text = typeof args === "string" ? args.trim() : "";
	if (text) station.deliverUserMessage(text);
}

export {
	onAssistantMessage,
	onMessageEnd,
	onToolCall,
	onHerdCommand,
	onContext,
	onSessionStop,
	onSessionSwitch,
	onSessionCompact,
	onBeforeAgentStart,
};
