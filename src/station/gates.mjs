// Station gatekeepers: synchronous external-event entries. Each function
// translates one host event into state transitions and, at the tail, a ticket
// call through the station's injected capability bundle.

import {
	chargeBranch,
	isFreeCall,
	truncateForHostBoundary,
	unreceivedChildren,
} from "../scope/index.mjs";
import { beatKey, toolCalls } from "../transcript/index.mjs";
import { READ_ONLY_SUBAGENT, READ_WRITE_SUBAGENT } from "../host/policy.mjs";
import { injectSystemPrompt } from "../host/prompts.mjs";
import {
	handoffToolBlockedReason,
	successorStartNudge,
} from "../relay/index.mjs";
import { continueFeedback } from "../tools/results.mjs";
import { record } from "../host/diagnostics.mjs";
import {
	CONTROL_TOOLS,
	controlsIn,
	hostBoundaryKey,
	parseArgs,
} from "./messages.mjs";
import { handoffDemandVisible, insideScopeNudge } from "./texts.mjs";
import { loadDoc } from "../prompts/index.mjs";

const E = loadDoc("errors");

/**
 * Record the model's own report while a handoff waits.
 *
 * Both message events carry the same text, so the rule lives here once: a
 * session outside every scope, with a handoff pending, whose assistant turn
 * made no tool call.
 */
function capturePendingReport(station, message) {
	const state = station.state;
	if (state.herdMode || !state.relay?.handoffPending) return;
	const ledger =
		typeof station.forkLedgerPort === "function" ? station.forkLedgerPort() : null;
	const ownerId =
		typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
	if (ledger && unreceivedChildren(ledger, ownerId ?? "root").length > 0) return;
	if (toolCalls(message).length > 0) return;
	const text = message?.content
		?.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n") ?? "";
	station.captureHandoffReport(text);
}

/**
 * Record one gate failure in the diagnostics ring.
 *
 * A real station owns `noteError`; a host double or a test stub may expose only
 * `lastError`. Both must land in the ring, because a swallowed message-event
 * failure is exactly the silence `herd-diag` exists to break.
 */
function noteFailure(station, error) {
	if (typeof station?.noteError === "function") {
		station.noteError("gates", error);
		return;
	}
	if (station) station.lastError = String(error?.message ?? error);
	record("gates", error);
}

function onAssistantMessage(station, message, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	try {
		station.onUsageMessage(message, ctx);
		station.dispatch.setPreparing(message);
		station.dispatch.rememberGroups(message);
		station.processAssistantMessage(message, { persisted: false });
		capturePendingReport(station, message);
		station.maybeNudge(message, ctx);
	} catch (error) {
		noteFailure(station, error);
	}
	return undefined;
}

function onMessageEnd(station, event, ctx) {
	if (event?.message?.role !== "assistant") return undefined;
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	const message = event.message;
	try {
		station.onUsageMessage(message, ctx);
		station.dispatch.rememberGroups(message);
		const controls = controlsIn(message);
		if (controls.length > 0) {
			const found = station.assistantForToolCall(controls[0].id);
			station.processAssistantMessage(message, { persisted: Boolean(found) });
		}
		capturePendingReport(station, message);
		station.maybeNudge(message, ctx);
	} catch (error) {
		noteFailure(station, error);
	}
	return undefined;
}

function onToolCall(station, event, ctx) {
	const { toolName, toolCallId } = event;
	// `permission` is a declaration, not an enforcement boundary. A scope that
	// says `"ro"` is trusted: the system never blocks a write because the scope
	// called itself read-only, and it never audits a tool call against the
	// claim. Mistake-proofing lives in the required field and in the two `rw`
	// refusals at begin time; it does not inspect what a tool would do.
	if (station.policy(ctx) === READ_ONLY_SUBAGENT && toolName !== "ask" && toolName !== "wait") {
		return undefined;
	}
	try {
		const state = station.state;
		if (!state.herdMode && state.relay?.handoffPending) {
			return {
				block: true,
				reason: handoffToolBlockedReason(),
			};
		}
		station.processControlsForTool(toolCallId);
		const input = event.input ?? event.arguments ?? {};
		if (toolName === "todo") {
			// todo is free at every level and is never withheld by the receive
			// obligation. An empty ledger submitted while the root still owns an
			// unreceived child is held by the relay transition instead of
			// arming a handoff that would abandon it.
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
				}
			}
			return undefined;
		}
		if (toolName === "ask") {
			if (state.herdMode) return undefined;
			return {
				block: true,
				reason: E["ask-blocked"],
			};
		}
		if (toolName === "wait") return undefined;
		const found = station.assistantForToolCall(toolCallId);
		if (found) station.dispatch.rememberGroups(found.message);
		const groupKey =
			station.dispatch.groupKeyFor(toolCallId) ??
			(found ? beatKey(found.message) : undefined);
		const beatTools = toolCalls(found?.message ?? station.messageForToolCall(toolCallId))
			.map((call) => ({
				name: call.name,
				free: isFreeCall(call.name, call.arguments),
			}));
		const ledger =
			typeof station.forkLedgerPort === "function" ? station.forkLedgerPort() : null;
		const ownerId =
			typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
		const charged = chargeBranch(state, ledger, {
			ownerId,
			toolCallId,
			toolName,
			groupKey,
			beatTools,
			input,
		});
		if (!charged.ok) {
			// A block without a reason reaches the model as the host's generic
			// "blocked by an extension" sentence. The refusal must always say
			// what was refused, even if a future accounting path forgets.
			const reason =
				typeof charged.reason === "string" && charged.reason !== ""
					? charged.reason
					: `Tool "${toolName}" was refused by scope accounting (${charged.code ?? "REFUSED"}).`;
			return { block: true, reason };
		}
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

function managesRequest(station, ctx) {
	return station.policy(ctx) !== READ_ONLY_SUBAGENT;
}

// Prepare state before the host copies the live loop for context extensions.
// The host adapter commits the returned receipt to all three histories.
function prepareRequest(station, ctx, previous, history) {
	if (!managesRequest(station, ctx)) return null;
	station.ensureTools(ctx);
	observeHostBoundary(station, station.contextMessages());
	station.observeActualModel(ctx);
	const restore = station.tickets.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	if (req) {
		return restore(station, ctx, req, previous, (message) =>
			message?.herdSkill === true ? message :
				station.skillReceipt(ctx, handoffDemandVisible(station.state.relay, history)),
		);
	}
	return previous?.herdSkill === true ? previous :
		station.skillReceipt(ctx, handoffDemandVisible(station.state.relay, history));
}

function onContext(station, messages, ctx) {
	const original = Array.isArray(messages) ? messages : [];
	if (!managesRequest(station, ctx)) return { messages: original };
	// Context handlers receive a clone. Adding a Skill here would make it
	// temporary and leave the running tool loop without it on the next call.
	return station.transformContext(original, ctx);
}

function onSessionStop(station, ctx) {
	if (station.state.herdMode) return undefined;
	if (!station.relayOn(ctx)) return undefined;
	const ledger =
		typeof station.forkLedgerPort === "function" ? station.forkLedgerPort() : null;
	const ownerId =
		typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
	// A returned child that no join has taken is unreceived work in exactly
	// the same sense as a running one. Counting only running children let a
	// stop through while a finished result sat unread.
	const unreceived =
		ledger && typeof unreceivedChildren === "function"
			? unreceivedChildren(ledger, ownerId ?? "root").length
			: 0;
	if (unreceived > 0) {
		return continueFeedback(insideScopeNudge(unreceived));
	}
	const relay = station.state.relay;
	if (relay?.canStop) return undefined;
	if (relay?.handoffPending) {
		if (station.handoffReport) {
			const committed = station.commitSelfHandoff(ctx, station.handoffReport);
			if (committed.ok) return continueFeedback(successorStartNudge(committed.relay));
		}
		// The demand already went out as a user prompt; repeating it as a
		// steer would say the same thing twice in different words.
		return undefined;
	}
	// A non-empty ledger used to be a reason to demand more work. It is not:
	// a stop there is a retirement, and the successor continues what is left.
	station.recordNaturalStop(ctx);
	return undefined;
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
	const prompt = injectSystemPrompt(event?.systemPrompt, station.registry?.ports?.() ?? {});
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
	const text = typeof args === "string" ? args.trim() : "";
	const toggled = station.herdPort().toggle(text);
	if (!toggled.ok) return toggled;
	station.persist();
	if (toggled.text) station.deliverUserMessage(toggled.text);
	return toggled;
}

export {
	onAssistantMessage,
	onMessageEnd,
	onToolCall,
	onHerdCommand,
	prepareRequest,
	onContext,
	onSessionStop,
	onSessionSwitch,
	onSessionCompact,
	onBeforeAgentStart,
};
