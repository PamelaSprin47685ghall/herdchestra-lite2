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
import { injectSystemPrompt } from "../prompts/inject.mjs";
import { READ_ONLY_SUBAGENT } from "../core/policy.mjs";
import { successorStartNudge } from "../relay/index.mjs";
import { continueFeedback } from "../tools/results.mjs";
import { controlsIn, hostBoundaryKey } from "./messages.mjs";
import { decideToolCall } from "./domain/tool-call.mjs";
import { PANHANDLE_TOOL } from "./domain/panhandle.mjs";
import { dispatchOf, processedOf } from "./domain/tool-call-ledger.mjs";
import { handoffDemandVisible, insideScopeNudge } from "./texts.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

const E = loadDoc("errors");

/**
 * The branch's own fork id, or null at the root.
 *
 * Every relay decision asks this question: the relay belongs to the root, and
 * a fork child shares the root's relay object only so a reload can see it. A
 * child never evaluates, arms, or commits a handoff.
 */
function ownerIdOf(station) {
	return typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
}

/**
 * Record the model's own report while a handoff waits.
 *
 * Both message events carry the same text, so the rule lives here once: a
 * session outside every scope, with a handoff pending, whose assistant turn
 * made no tool call. A child's prose is fork output, never the root's report.
 */
function capturePendingReport(station, message) {
	const state = station.state;
	if (!state.autopilot || !state.relay?.handoffPending) return;
	if (ownerIdOf(station) !== null) return;
	const ledger =
		typeof station.forkLedgerPort === "function" ? station.forkLedgerPort() : null;
	if (ledger && unreceivedChildren(ledger, "root").length > 0) return;
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
	station?.host?.record?.("gates", error);
}

function onAssistantMessage(station, message, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	try {
		station.onUsageMessage(message, ctx);
		dispatchOf(station).setPreparing(message);
		dispatchOf(station).rememberGroups(message);
		station.processAssistantMessage(message);
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
		dispatchOf(station).rememberGroups(message);
		const controls = controlsIn(message);
		if (controls.length > 0) {
			station.processAssistantMessage(message);
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
	const cached = station.toolGateVerdict?.(toolCallId);
	if (cached?.hit) return cached.verdict;
	const input = event.input ?? event.arguments ?? {};
	try {
		const state = station.state;
		const ownerId = ownerIdOf(station);
		const found =
			typeof station.assistantForToolCall === "function"
				? station.assistantForToolCall(toolCallId)
				: null;
		if (found && typeof dispatchOf(station)?.rememberGroups === "function") {
			dispatchOf(station).rememberGroups(found.message);
		}
		const groupKey =
			dispatchOf(station)?.groupKeyFor?.(toolCallId) ??
			(found ? beatKey(found.message) : undefined);
		const carrying =
			found?.message ??
			(typeof station.messageForToolCall === "function"
				? station.messageForToolCall(toolCallId)
				: null);
		const beatTools = toolCalls(carrying).map((call) => ({
			name: call.name,
			// A panhandle funds the beat, so it takes no share of the beat. Leaving
			// it budgeted would shrink the share of the work it just paid for.
			free: call.name === PANHANDLE_TOOL || isFreeCall(call.name, call.arguments),
		}));
		const handled =
			typeof processedOf(station)?.hasHandled === "function"
				? processedOf(station).hasHandled(toolCallId)
				: false;
		const decision = decideToolCall({
			state: {
				autopilot: state.autopilot,
				relay: { handoffPending: state.relay?.handoffPending === true },
				charges: state.charges,
			},
			processed: {
				handled,
				hasCall:
					typeof processedOf(station)?.hasCall === "function"
						? processedOf(station).hasCall(toolCallId)
						: false,
			},
			dispatch: { found: Boolean(found), groupKey, beatTools },
			call: { toolName, toolCallId, input },
			policy: station.policy(ctx),
			relay: {
				ownerId,
				handoffPending: state.relay?.handoffPending === true,
				owesLedger: station.relayPort?.().owesLedger?.() === true,
				timeLimitMs: null,
			},
		});
		if (decision.controls.process) station.processControlsForTool(toolCallId);
		if (
			decision.controls.directAmend &&
			!processedOf(station)?.hasHandled?.(toolCallId)
		) {
			station.directAmend(toolCallId, decision.controls.directAmend.args);
		}
		if (decision.charge) {
			const ledger =
				typeof station.forkLedgerPort === "function"
					? station.forkLedgerPort()
					: null;
			const charged = chargeBranch(state, ledger, decision.charge.request);
			if (!charged.ok) {
				// A block without a reason reaches the model as the host's
				// generic "blocked by an extension" sentence. The refusal must
				// always say what was refused.
				const reason =
					typeof charged.reason === "string" && charged.reason !== ""
						? charged.reason
						: `Tool "${toolName}" was refused by scope accounting (${charged.code ?? "REFUSED"}).`;
				const verdict = { block: true, reason };
				station.rememberToolGate?.(toolCallId, verdict);
				return verdict;
			}
		}
		if (decision.persist) station.persist();
		const verdict =
			decision.verdict === "block"
				? { block: true, reason: decision.block?.reason ?? "Tool blocked." }
				: undefined;
		station.rememberToolGate?.(toolCallId, verdict);
		return verdict;
	} catch (error) {
		const verdict = {
			block: true,
			reason: render(E["accounting-failed-closed"], {
				error: String(error?.message ?? error),
			}),
		};
		station.rememberToolGate?.(toolCallId, verdict);
		return verdict;
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
function receiptMatches(station, message) {
	if (message?.herdSkill !== true) return false;
	return message.autopilot === (station.state.autopilot === true) &&
		message.branch === (ownerIdOf(station) !== null);
}

function prepareRequest(station, ctx, previous, history) {
	if (!managesRequest(station, ctx)) return null;
	// Commit every transition before dispatching. `ensureTools` and
	// `restoreScopedModel` detach tickets, and a ticket's synchronous prefix
	// must observe a fully prepared request, not a half-updated one.
	observeHostBoundary(station, station.contextMessages());
	station.observeActualModel(ctx);
	const demandVisible =
		ownerIdOf(station) === null
			? handoffDemandVisible(station.state.relay, history)
			: false;
	const restore = station.tickets.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	const receipt = (message) =>
		receiptMatches(station, message) ? message :
			station.skillReceipt(ctx, demandVisible);
	// `skillReceipt` writes the relay verdict, so it commits before dispatch.
	const next = req
		? null
		: receiptMatches(station, previous) ? previous :
			station.skillReceipt(ctx, demandVisible);
	// Tail position: the todo grant, then the restore ticket.
	station.ensureTools(ctx);
	if (req) return restore(station, ctx, req, previous, receipt);
	return next;
}

function onContext(station, messages, ctx) {
	const original = Array.isArray(messages) ? messages : [];
	if (!managesRequest(station, ctx)) return { messages: original };
	// Context handlers receive a clone. Adding a Skill here would make it
	// temporary and leave the running tool loop without it on the next call.
	return station.transformContext(original, ctx);
}

function onSessionStop(station, ctx, evidence = null) {
	// The host reports a stop it already aborted, or one whose assistant
	// message ended in an error. Neither is user intent to stop, and both
	// must bypass every relay decision. Keeping the test here leaves the hook
	// a pure binding and puts the rule beside the state it protects.
	if (evidence?.signal?.aborted || evidence?.reason === "aborted" || evidence?.reason === "error") {
		return undefined;
	}
	if (!station.state.autopilot) return undefined;
	if (!station.relayOn(ctx)) return undefined;
	const ledger =
		typeof station.forkLedgerPort === "function" ? station.forkLedgerPort() : null;
	const ownerId = ownerIdOf(station);
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
	// A child's natural stop is not a ledger submission. The host's branch
	// contract keeps it working until `scope_return`; the root relay must not
	// arm a handoff or capture the child's prose as the root's report.
	if (ownerId !== null) return undefined;
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
	const prompt = injectSystemPrompt(event?.systemPrompt, {
		...station.portTable,
		autopilot: station.state.autopilot === true,
		branch: ownerIdOf(station) !== null,
	});
	const promptChanged = prompt !== event?.systemPrompt;
	const result = promptChanged ? { systemPrompt: prompt } : undefined;
	if (policy === READ_ONLY_SUBAGENT) return result;
	// The host selects the provider model before it calls the context hook.
	observeHostBoundary(station, station.contextMessages());
	station.observeActualModel(ctx);
	const restore = station.tickets.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	// Relay and `todo` share one verdict: `ensureTools` owns that rule, so no
	// second `getActiveTools` check may live here. Tail position: every state
	// commit above lands before the grant (and the restore) dispatch.
	station.ensureTools(ctx);
	if (req) return restore(station, ctx, req, result);
	return result;
}

function onAutopilotCommand(station, args) {
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
	onAutopilotCommand,
	prepareRequest,
	onContext,
	onSessionStop,
	onSessionSwitch,
	onSessionCompact,
	onBeforeAgentStart,
};
