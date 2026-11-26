// Station gatekeepers: synchronous external-event entries. Each function
// translates one host event into state transitions and, at the tail, a ticket
// call through the station's injected capability bundle.

import {
	chargeBranch,
	forkOf,
	isFreeCall,
	RUNNING,
	truncateForHostBoundary,
	unreceivedChildren,
} from "../scope/index.mjs";
import { childReturnNudge, takeReturnNudge } from "../scope/return-nudge.mjs";
import { abandonDescendants } from "../scope/forkjoin.mjs";
import { notifyWaiters } from "../scope/fork-registry.mjs";
import { beatKey, toolCalls } from "../transcript/index.mjs";
import { injectSystemPrompt } from "../prompts/inject.mjs";
import { READ_ONLY_SUBAGENT } from "../core/policy.mjs";
import { continueFeedback } from "../tools/results.mjs";
import { controlsIn, hostBoundaryKey } from "./messages.mjs";
import { firstTurnMessage, prependFirstTurn } from "./domain/context.mjs";
import { decideToolCall } from "./domain/tool-call.mjs";
import { dispatchOf, processedOf } from "./domain/tool-call-ledger.mjs";
import { insideScopeNudge, rootReturnNudge } from "./texts.mjs";
import {
	clearPendingRootRewind,
	pendingRootRewindPlan,
	syncRootUserPrompts,
} from "./handoff-state.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

const E = loadDoc("errors");

/** The branch's own fork id, or null at the root. */
function ownerIdOf(station) {
	return typeof station.forkOwnerId === "function" ? station.forkOwnerId() : null;
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
	(station?.host?.report?.record ?? station?.host?.record)?.("gates", error);
}

function onAssistantMessage(station, message, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	try {
		station.onUsageMessage(message, ctx);
		dispatchOf(station).setPreparing(message);
		dispatchOf(station).rememberGroups(message);
		station.processAssistantMessage(message);
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
			free: isFreeCall(call.name, call.arguments),
		}));
		const handled =
			typeof processedOf(station)?.hasHandled === "function"
				? processedOf(station).hasHandled(toolCallId)
				: false;
		const decision = decideToolCall({
			state: {
				autopilot: state.autopilot,
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

/**
 * The boundary key for this exact message array.
 *
 * `hostBoundaryKey` walks backwards until it finds a handoff marker, so a
 * transcript with none costs Θ(entries). The projection is cached per leaf,
 * which means the same array object arrives on every event of a turn; its
 * length is the only thing an append changes, so identity plus length proves
 * the scan would return the same answer.
 */
function cachedHostBoundaryKey(station, messages) {
	const scan = station.hostBoundaryScan;
	if (scan && scan.messages === messages && scan.length === messages.length) {
		return scan.key;
	}
	const key = hostBoundaryKey(messages);
	station.hostBoundaryScan = { messages, length: messages.length, key };
	return key;
}

function observeHostBoundary(station, messages) {
	const boundaryKey = cachedHostBoundaryKey(station, messages);
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
		message.branch === (ownerIdOf(station) !== null) &&
		message.canStop === (station.state.relay?.canStop === true);
}

function prepareRequest(station, ctx, previous, history) {
	if (!managesRequest(station, ctx)) return null;
	// Commit every transition before dispatching. `restoreScopedModel` detaches
	// a ticket, and its synchronous prefix must observe a fully prepared
	// request, not a half-updated one.
	const contextMessages = station.contextMessages();
	observeHostBoundary(station, contextMessages);
	if (ownerIdOf(station) === null) {
		const live = history
			? [...(history.prefix ?? []), ...(history.pending ?? [])]
			: contextMessages;
		syncRootUserPrompts(station, live);
	}
	station.observeActualModel(ctx);
	const restore = station.tickets?.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	const receipt = (message) =>
		receiptMatches(station, message) ? message : station.skillReceipt(ctx);
	// `skillReceipt` builds the receipt synchronously before dispatch.
	const next = req
		? null
		: receiptMatches(station, previous) ? previous : station.skillReceipt(ctx);
	// Tail position: the restore ticket.
	if (req) return restore(station, ctx, req, previous, receipt);
	return next;
}

// A projection can lose the opening in two ways: it throws, or it returns the
// list it was given. Presence, not length, decides restoration: an amendment
// legitimately shortens the list while still carrying the opening, so a length
// test would inject a second copy on every amended request.
function carriesFirstTurn(messages, turn) {
	const head = turn.map(firstTurnMessage);
	let at = 0;
	while (at < messages.length) {
		const role = messages[at]?.role;
		if (role !== "system" && role !== "developer") break;
		at += 1;
	}
	if (at + head.length > messages.length) return false;
	return head.every((message, index) => {
		const actual = messages[at + index];
		return actual?.role === message.role &&
			JSON.stringify(actual?.content) === JSON.stringify(message.content);
	});
}

function onContext(station, messages, ctx, firstTurn = null) {
	const original = Array.isArray(messages) ? messages : [];
	const injected = () => ({ messages: prependFirstTurn(original, firstTurn) });
	// The host applies whatever this handler returns as the outbound list. A
	// thrown error is swallowed by the extension runner, and a projection that
	// failed returns the original list unchanged, so both failures look exactly
	// like a first turn that was never configured: no injection, no symptom the
	// provider can report. The opening is therefore restored on both paths.
	try {
		if (!managesRequest(station, ctx)) return injected();
		// Context handlers receive a clone. Adding a Skill here would make it
		// temporary and leave the running tool loop without it on the next call.
		const result = station.transformContext(original, ctx, firstTurn);
		if (Array.isArray(firstTurn) && firstTurn.length > 0) {
			const projected = Array.isArray(result?.messages) ? result.messages : [];
			if (!carriesFirstTurn(projected, firstTurn)) return injected();
		}
		return result;
	} catch (error) {
		station.noteError("context", error);
		return injected();
	}
}

/**
 * Cancel open descendants from one owner down.
 *
 * Esc ends the whole branch, not only the station that saw it. The ledger
 * closes each descendant before the live agent is stopped, so the reason the
 * parent reads is the cancellation and not a prompt that resolved with
 * "aborted". Running ids go to the host through the abort port because only
 * the wiring holds a session handle; the ledger stays the source of truth.
 */
const CANCELLED_BY_PARENT = "cancelled by the parent scope";

export function cancelDescendants(station, reason = CANCELLED_BY_PARENT) {
	return cancelTree(station, ownerIdOf(station) ?? "root", reason);
}

/**
 * Cancel the conversation's whole open fork tree, independent of which
 * station received the user's abort. USER_ABORT is a decision about the
 * branch, not about the agent whose host happened to observe it.
 */
export function cancelTree(station, rootOwnerId = "root", reason = CANCELLED_BY_PARENT) {
	const ledger =
		typeof station.forkLedgerPort === "function" ? station.forkLedgerPort() : null;
	if (!ledger || typeof ledger !== "object") {
		return { abandonedIds: [], runningIds: [] };
	}
	const { abandonedIds, runningIds } = abandonDescendants(ledger, rootOwnerId, reason);
	if (abandonedIds.length === 0 && runningIds.length === 0) {
		return { abandonedIds, runningIds };
	}
	const wait =
		typeof station.forkWaitPort === "function" ? station.forkWaitPort() : null;
	// A join parked anywhere in this tree wakes now: its child is gone, so
	// waiting for a return that will never come is a deadlock.
	notifyWaiters(wait?.registry);
	// `persistLedger` is the station's own seam: a child's identity points it
	// at the root branch, and a bare station falls back to its own persist.
	if (typeof station.persistLedger === "function") station.persistLedger();
	else if (typeof station.persist === "function") station.persist();
	// Tail position: every state commit above lands before the agents stop.
	if ((runningIds.length > 0 || abandonedIds.length > 0) && typeof station.abortChildrenPort === "function") {
		station.abortChildrenPort(runningIds, abandonedIds);
	}
	return { abandonedIds, runningIds };
}

/**
 * Post-loop gate for Root rewinds.
 *
 * When Root called `scope_return` and scheduled a rewind (`pendingRewind`),
 * `stopAfterScopeReturn` ended the loop cleanly via `TERMINAL_RESULT`. Here at
 * `agent_end`, the loop is idle, so the station commits nothing destructive
 * itself and tail-dispatches the host `rewindRoot` ticket (which settles
 * persistence, calls `station.commitRootRewind(ctx, plan)` synchronously, and
 * prompts the reborn Root).
 *
 * USER_ABORT never enters here: Esc enters only through `onUserAbort`.
 */
function onAgentEnd(station, ctx, event = null) {
	if (event?.willContinue === true) return undefined;
	if (ownerIdOf(station) !== null) return undefined;
	const plan = pendingRootRewindPlan(station);
	if (!plan) return undefined;
	// Prevent double-dispatch if two agent_end notifications arrive before the
	// ticket commits and clears `pendingRewind`.
	if (station.rewindDispatching === plan.pending) return undefined;
	const rewindRoot = station.tickets?.rewindRoot;
	if (typeof rewindRoot !== "function") {
		// Fallback for minimal/test stations that do not inject the async host
		// ticket: commit synchronously and deliver the start prompt at the tail.
		const committed = station.commitRootRewind?.(ctx, plan);
		if (committed) {
			station.rewoundThisTurn = true;
			station.deliverUserMessage?.(plan.startPrompt);
		}
		return undefined;
	}
	station.rewindDispatching = plan.pending;
	station.rewoundThisTurn = true;
	// Tail position: detach the async rewind ticket with catch-all diagnostics.
	station.dispatchFireAndForget("handoff", () => rewindRoot(station, ctx, plan));
	return undefined;
}

function onSessionStop(station, ctx, evidence = null) {
	// Host stop evidence never proves USER_ABORT. An errored turn and an
	// aborted turn leave children alive and bypass stop nudges.
	if (evidence?.signal?.aborted || evidence?.reason === "error" || evidence?.reason === "aborted") {
		return undefined;
	}
	// A Root rewind just finished or is in flight on this turn: do not nudge
	// against the turn that is being replaced.
	if (station.rewoundThisTurn === true) {
		station.rewoundThisTurn = false;
		return undefined;
	}
	if (ownerIdOf(station) === null && station.state?.relay?.pendingRewind) {
		return undefined;
	}
	const ledger =
		typeof station.forkLedgerPort === "function" ? station.forkLedgerPort() : null;
	const ownerId = ownerIdOf(station);
	// Unreceived children (running or ready) outrank every other stop rule,
	// for both Root (even with autopilot off) and child scopes.
	const unreceived =
		ledger && typeof unreceivedChildren === "function"
			? unreceivedChildren(ledger, ownerId ?? "root").length
			: 0;
	if (unreceived > 0) {
		return continueFeedback(insideScopeNudge(unreceived));
	}
	// Child scope natural stop backstop: nudge to call `scope_return` while
	// the bracket is still RUNNING and its shared allowance remains.
	if (ownerId !== null && ledger) {
		const self = forkOf(ledger, ownerId);
		if (self && self.status === RUNNING && takeReturnNudge(self)) {
			return continueFeedback(childReturnNudge());
		}
		return undefined;
	}
	// Root natural stop: allowed when autopilot is off or after two consecutive
	// big `scope_return` oaths (`canStop === true`). Otherwise nudge to call
	// `scope_return`.
	if (!station.state?.autopilot) return undefined;
	if (station.state?.relay?.canStop === true) return undefined;
	return continueFeedback(rootReturnNudge());
}

function onSessionSwitch(station, event, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return;
	clearPendingRootRewind(station);
	const reason = event?.reason ?? event?.handoffReason;
	if (reason !== "handoff" && event?.handoff !== true) return;
	truncateForHostBoundary(station.state);
	station.resetUsageWatermark();
	station.persist();
}

function onSessionCompact(station, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return;
	clearPendingRootRewind(station);
	truncateForHostBoundary(station.state);
	station.hostBoundaryKey = cachedHostBoundaryKey(station, station.contextMessages()) ?? station.hostBoundaryKey;
	station.resetUsageWatermark();
	station.persist();
	const restore = station.tickets?.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	if (req) return restore(station, ctx, req);
}

function onBeforeAgentStart(station, event, ctx) {
	const policy = station.policy(ctx);
	// No mode or scope argument: the managed block is the same bytes for an
	// owner and a forked scope, so an inherited prompt comes back untouched and
	// the host keeps the provider cache key it handed to the branch.
	const prompt = injectSystemPrompt(event?.systemPrompt, {
		...station.portTable,
	});
	const promptChanged = prompt !== event?.systemPrompt;
	const result = promptChanged ? { systemPrompt: prompt } : undefined;
	if (policy === READ_ONLY_SUBAGENT) return result;
	station.rewoundThisTurn = false;
	const contextMessages = station.contextMessages();
	// The host selects the provider model before it calls the context hook.
	observeHostBoundary(station, contextMessages);
	if (ownerIdOf(station) === null) {
		syncRootUserPrompts(station, contextMessages);
	}
	station.observeActualModel(ctx);
	const restore = station.tickets?.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	// Tail position: every state commit above lands before the restore dispatch.
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
	onAgentEnd,
	onSessionStop,
	onSessionSwitch,
	onSessionCompact,
	onBeforeAgentStart,
};
