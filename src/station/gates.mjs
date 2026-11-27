// Station gatekeepers: synchronous external-event entries. Each function
// translates one host event into state transitions and, at the tail, a ticket
// call through the station's injected capability bundle.

import {
	forkOf,
	RUNNING,
	truncateForHostBoundary,
} from "../scope/index.mjs";
import { childReturnNudge, takeReturnNudge } from "../scope/return-nudge.mjs";
import { abandonDescendants } from "../scope/forkjoin.mjs";
import { notifyWaiters } from "../scope/fork-registry.mjs";
import { injectSystemPrompt } from "../prompts/inject.mjs";
import { mergeFeatures, parseGoalCommand, parseHerdCommand } from "../features/herd/features.mjs";
import { createRelay } from "../relay/state.mjs";
import { READ_ONLY_SUBAGENT } from "../core/policy.mjs";
import { continueFeedback } from "../tools/results.mjs";
import { hostBoundaryKey } from "./messages.mjs";
import { forkRegistryOf } from "./ports-contract.mjs";
import {
	clearPendingRootRewind,
	pendingRootRewindPlan,
	syncRootUserPrompts,
} from "./handoff-state.mjs";
import { insideScopeNudge, rootReturnNudge, stopNudge } from "./texts.mjs";

/** The branch's own fork id, or null at the root. */
function ownerIdOf(station) {
	return station.forkOwnerId?.() ?? null;
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
		// A js call carries its own accounting in `finishJsCall`; the message
		// event only updates usage and asks whether this turn ended without
		// the move the current mode requires.
		station.maybeNudge(message, ctx);
	} catch (error) {
		noteFailure(station, error);
	}
	return undefined;
}

function onMessageEnd(station, event, ctx) {
	if (event?.message?.role !== "assistant") return undefined;
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return undefined;
	try {
		station.onUsageMessage(event.message, ctx);
		station.maybeNudge(event.message, ctx);
	} catch (error) {
		noteFailure(station, error);
	}
	return undefined;
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
	station.resetDirectoryBaseline?.();
	station.resetUsageWatermark();
	station.persist();
}

function managesRequest(station, ctx) {
	return station.policy(ctx) !== READ_ONLY_SUBAGENT;
}

/**
 * A committed receipt is still current when its `capSig` matches the
 * projection this request would print. The signature hashes the mode, the
 * queued request id, the tool names and the whole printed `state`, so it
 * changes whenever a probe byte would change — `remaining` included.
 */
function receiptMatches(station, message, ctx) {
	if (message?.herdSkill !== true) return false;
	if (typeof message.capSig !== "string" || message.capSig === "") return false;
	return message.capSig === station.capSignature(ctx);
}

function prepareRequest(station, ctx, previous, history) {
	if (!managesRequest(station, ctx)) return null;
	// Commit every transition before dispatching. `restoreScopedModel` detaches
	// a ticket, and its synchronous prefix must observe a fully prepared
	// request, not a half-updated state.
	const contextMessages = station.contextMessages();
	observeHostBoundary(station, contextMessages);
	if (ownerIdOf(station) === null) {
		const live = history
			? [...(history.prefix ?? []), ...(history.pending ?? [])]
			: contextMessages;
		syncRootUserPrompts(station, live);
	}
	station.observeActualModel(ctx);
	station.noteSnapshotLeaf?.(ctx);
	const restore = station.tickets?.restoreScopedModel;
	const req = restore && station.state.modelRecovery && station.takePendingModelSwitch(ctx);
	const receipt = (message) =>
		receiptMatches(station, message, ctx) ? message : station.skillReceipt(ctx);
	// `skillReceipt` builds the receipt synchronously before dispatch.
	const next = req
		? null
		: receiptMatches(station, previous, ctx) ? previous : station.skillReceipt(ctx);
	// Tail position: the restore ticket.
	if (req) return restore(station, ctx, req, previous, receipt);
	return next;
}

function onContext(station, messages, ctx) {
	const original = Array.isArray(messages) ? messages : [];
	// The host applies whatever this handler returns as the outbound list. A
	// thrown error is swallowed by the extension runner, so both a refusal and
	// a failed projection return the original list unchanged instead of an
	// undefined outbound request.
	try {
		if (!managesRequest(station, ctx)) return { messages: original };
		return station.transformContext(original, ctx);
	} catch (error) {
		station.noteError("context", error);
		return { messages: original };
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
		station.forkLedgerPort?.() ?? null;
	if (!ledger || typeof ledger !== "object") {
		return { abandonedIds: [], runningIds: [] };
	}
	const { abandonedIds, runningIds, liveIds } = abandonDescendants(ledger, rootOwnerId, reason);
	if (abandonedIds.length === 0 && runningIds.length === 0 && liveIds.length === 0) {
		return { abandonedIds, runningIds };
	}
	const registry = forkRegistryOf(station);
	if (registry) {
		// A join parked anywhere in this tree wakes now: its child is gone, so
		// waiting for a return that will never come is a deadlock.
		notifyWaiters(registry);
	}
	// `persistLedger` is the station's own seam: a child's identity points it
	// at the root branch, and a bare station falls back to its own persist.
	if (typeof station.persistLedger === "function") station.persistLedger();
	else if (typeof station.persist === "function") station.persist();
	// Tail position: every state commit above lands before the agents stop.
	// The first two lists describe what the ledger did; the third names every
	// descendant that may still own a live agent — running, returned, or
	// joined — because Esc stops the branch, not only the closed records.
	if (liveIds.length > 0 && typeof station.abortChildrenPort === "function") {
		station.abortChildrenPort(runningIds, abandonedIds, liveIds);
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
	// Ignore pauses where the host itself is continuing the turn (retry,
	// compaction continuation, session_stop). When the host paused only because
	// async work is pending (`awaitingAsyncWork: true` — including our rewind
	// run-hold job or live forked children during a small rewind), the old turn
	// has yielded and the root rewind handoff must proceed.
	if (event?.willContinue === true && event?.awaitingAsyncWork !== true) return undefined;
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
	const projection = station.projectionFor(ctx);
	const unreceived = projection.state?.unreceived ?? 0;
	const ledger = station.forkLedgerPort?.() ?? null;
	const ownerId = ownerIdOf(station);
	// A hard mode has exactly one legal move. Stopping without it is a missed
	// turn, so the steer names that move and nothing else.
	if (projection.mode === "ABANDONED") {
		if (ownerId !== null && ledger) {
			const self = forkOf(ledger, ownerId);
			if (!self || self.status !== RUNNING || !takeReturnNudge(self)) {
				return undefined;
			}
		}
		return continueFeedback(
			stopNudge("ABANDONED", {
				abandoned: projection.state?.abandoned,
			}),
		);
	}
	if (projection.mode === "CONTEXT_LIMIT") {
		return continueFeedback(
			stopNudge(projection.mode, { unreceived }),
		);
	}
	if (projection.mode === "FINAL_ANSWER") {
		// Delivery seals a one-shot goal session: the next turn starts manual.
		station.endGoalSession?.();
		return undefined;
	}
	// Unreceived subscopes (running or ready) outrank every other stop rule,
	// for both Root (even outside a goal session) and subscope scopes.
	if (unreceived > 0) {
		return continueFeedback(insideScopeNudge(unreceived));
	}
	// Subscope natural stop backstop: nudge to call `scope_return` while
	// the bracket is still RUNNING and its shared allowance remains.
	if (ownerId !== null && ledger) {
		const self = forkOf(ledger, ownerId);
		if (self && self.status === RUNNING && takeReturnNudge(self)) {
			return continueFeedback(childReturnNudge());
		}
		return undefined;
	}
	// Root natural stop: allowed outside a goal session, or after a sealed
	// `scope_return` (`canStop === true`). Otherwise nudge to call
	// `scope_return`.
	if (station.state?.relay?.goal !== true) return undefined;
	if (station.state?.relay?.canStop === true) return undefined;
	return continueFeedback(rootReturnNudge());
}

function onSessionSwitch(station, event, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return;
	clearPendingRootRewind(station);
	const reason = event?.reason ?? event?.handoffReason;
	if (reason !== "handoff" && event?.handoff !== true) return;
	truncateForHostBoundary(station.state);
	station.resetDirectoryBaseline?.();
	station.resetUsageWatermark();
	station.persist();
}

function onSessionCompact(station, ctx) {
	if (station.policy(ctx) === READ_ONLY_SUBAGENT) return;
	clearPendingRootRewind(station);
	truncateForHostBoundary(station.state);
	station.hostBoundaryKey = cachedHostBoundaryKey(station, station.contextMessages()) ?? station.hostBoundaryKey;
	station.resetDirectoryBaseline?.();
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
	//
	// The tool declarations are compiled once from the confiscated tools' own
	// JSON schemas and cached by name set inside `injectSystemPrompt`, so a
	// long session does not rebuild them and the prefix stays byte-identical.
	const specs =
		typeof station.host?.tools?.listSpecs === "function"
			? station.host.tools.listSpecs(ctx) ?? []
			: [];
	const prompt = injectSystemPrompt(event?.systemPrompt, {
		features: station.state?.features,
		toolSpecs: specs,
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

function onHerdCommand(station, args) {
	if (station.portTable?.herd !== "on") {
		return { ok: false, code: "HERD_UNAVAILABLE", message: "/herd is disabled by HERD_HERD=off" };
	}
	if (!station.state.features) station.state.features = mergeFeatures({}, {});
	const parsed = parseHerdCommand(args, station.state.features);
	if (parsed.kind === "refuse") return { ok: false, ...parsed };
	if (parsed.kind === "set") {
		station.state.features[parsed.feature] = parsed.state;
		station.persist();
		if (parsed.text) station.deliverUserMessage(parsed.text);
	}
	return { ok: true, ...parsed };
}

/**
 * `/herd-goal <instruction>`: open one goal session and immediately run it.
 *
 * A goal session is a Shift, not Caps Lock: the flag lives in `relay.goal`,
 * stays on across interrupted turns, and is released by a bare `/herd-goal` or
 * by the sealed delivery. Every state change lands before the tail dispatch, so
 * the ticket's synchronous prefix never sees a half-updated relay.
 */
function onGoalCommand(station, args) {
	if (station.portTable?.herd !== "on") {
		return {
			ok: false,
			code: "HERD_UNAVAILABLE",
			message: "/herd-goal is disabled by HERD_HERD=off",
		};
	}
	const parsed = parseGoalCommand(args);
	if (parsed.kind === "off") {
		if (station.state?.relay?.goal === true) {
			station.state.relay.goal = false;
			station.persist();
			return { ok: true, kind: "off", goal: false, message: "goal mode off" };
		}
		return { ok: true, kind: "off", goal: false, message: "goal mode is already off" };
	}
	if (!station.state.relay || typeof station.state.relay !== "object") {
		station.state.relay = createRelay();
	}
	station.state.relay.goal = true;
	station.state.relay.canStop = false;
	station.persist();
	station.deliverUserMessage(parsed.text);
	return {
		ok: true,
		kind: "goal",
		text: parsed.text,
		message: "goal started (auto-exits on delivery)",
	};
}

export {
	onAssistantMessage,
	onMessageEnd,
	onHerdCommand,
	onGoalCommand,
	prepareRequest,
	onContext,
	onAgentEnd,
	onSessionStop,
	onSessionSwitch,
	onSessionCompact,
	onBeforeAgentStart,
};
