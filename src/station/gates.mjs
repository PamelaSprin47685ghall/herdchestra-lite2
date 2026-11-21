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
import { record } from "../host/diagnostics.mjs";
import { ownerRetirement } from "./retirement.mjs";
import {
	CONTROL_TOOLS,
	controlsIn,
	hostBoundaryKey,
	parseArgs,
} from "./messages.mjs";
import { insideScopeText } from "./texts.mjs";
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
	if (state.herdMode || currentScope(state) || !state.relay?.handoffPending) return;
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

/**
 * Admit one call listed after `scope({ begin })` in the same assistant
 * message. The owner executes it exactly once; the scheduler copies its result
 * into every flow. A call no flow budgeted cannot be paid for, so it is
 * refused before it runs.
 */
function admitTrailing(station, event, atDispatch) {
	const { toolName, toolCallId } = event;
	const pending = station.pendingFission;
	if (toolName === "todo") {
		return {
			block: true,
			reason:
				"TODO_OUTSIDE_SCOPE_ONLY: todo is forbidden inside any active scope; the barrier call runs in the owner's context.",
		};
	}
	if (toolName === "scope") {
		const args = parseArgs({ arguments: event.input ?? event.arguments ?? {} });
		if (args.begin !== undefined && args.begin !== null) {
			return {
				block: true,
				reason: `FISSION_BATCH_PENDING: a second batch cannot open before batch ${pending.batchId} retires.`,
			};
		}
		if (args.end === true) {
			return {
				block: true,
				reason:
					"SAME_MESSAGE_BOUNDARY: a scope cannot be opened and closed in the same assistant message.",
			};
		}
	}
	if (toolName === "ask") {
		if (station.state.herdMode && pending.stage === DECISION_FRAMING) return undefined;
		return {
			block: true,
			reason:
				'ask is allowed only when the user has enabled /herd and the current scope has stage: "decision-framing".',
		};
	}
	if (toolName === "wait") return undefined;
	if (CONTROL_TOOLS.has(toolName)) return undefined;
	const input = event.input ?? event.arguments ?? {};
	if (isFreeCall(toolName, input)) return undefined;
	const tool = toolName === "apply_patch" ? "edit" : toolName;
	const totals = pending.totals ?? {};
	if (!(Number(totals[tool]) > 0)) {
		return {
			block: true,
			reason: `BUDGET_EXHAUSTED: no flow in batch ${pending.batchId} budgets "${tool}", so the shared first beat cannot pay for it.`,
		};
	}
	if (!atDispatch && !pending.trailingExecuted.some((entry) => entry.toolCallId === toolCallId)) {
		pending.trailingExecuted.push({ toolCallId, toolName, input });
		station.persist?.();
	}
	return undefined;
}

function onAssistantMessage(station, message, ctx) {
	if (!station.fissionFlow && station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
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
		capturePendingReport(station, message);
		station.maybeNudge(message, ctx);
	} catch (error) {
		noteFailure(station, error);
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
	const pending = station.pendingFission;
	if (
		pending &&
		pending.retired !== true &&
		pending.remainingTrailingIds instanceof Set &&
		pending.remainingTrailingIds.has(toolCallId)
	) {
		return admitTrailing(station, event, atDispatch);
	}
	// `permission` is a declaration, not an enforcement boundary. A scope that
	// says `"ro"` is trusted: the system never blocks a write because the scope
	// called itself read-only, and it never audits a tool call against the
	// claim. Mistake-proofing lives in the required field and in the two `rw`
	// refusals at begin time; it does not inspect what a tool would do.
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
				reason: E["not-in-scope"],
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

function managesRequest(station, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return false;
	if (!station.fissionFlow && (station.ownerRetirement?.(ctx) || station.pendingFission?.retired === true)) {
		return false;
	}
	return true;
}

// Prepare state before the host copies the live loop for context extensions.
// The host adapter commits the returned receipt to all three histories.
function prepareRequest(station, ctx, previous) {
	if (!managesRequest(station, ctx)) return null;
	station.ensureTools(ctx);
	observeHostBoundary(station, station.contextMessages());
	station.observeActualModel(ctx);
	const restore = station.tickets.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	if (req) {
		return restore(station, ctx, req, previous, (message) =>
			message?.herdSkill === true ? message : station.skillReceipt(ctx),
		);
	}
	return previous?.herdSkill === true ? previous : station.skillReceipt(ctx);
}

function onContext(station, messages, ctx) {
	const original = Array.isArray(messages) ? messages : [];
	if (!managesRequest(station, ctx)) return { messages: original };
	// Context handlers receive a clone. Adding a Skill here would make it
	// temporary and leave the running tool loop without it on the next call.
	return station.transformContext(original, ctx);
}

function onSessionStop(station, ctx) {
	// Flow turns are settled and nudged by their scheduler, after the host's
	// recovery and abort have finished. A second continuation here races it.
	if (station.fissionFlow) return undefined;
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
	prepareRequest,
	onContext,
	onSessionStop,
	onSessionSwitch,
	onSessionCompact,
	onBeforeAgentStart,
};
