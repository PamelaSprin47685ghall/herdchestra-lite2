/**
 * Herdchestra Lite 2.0 SessionStation.
 *
 * The station holds all scope/relay state and exposes pure synchronous
 * gatekeeper methods. Tickets (async) live in ../tools/tickets.mjs and
 * ../handoff/*.mjs; wiring (../activation/*.mjs) binds host events to these
 * gatekeepers and injects ticket capabilities.
 *
 * Station rules (AGENTS.md Ticket Station Method):
 * - Every method is a plain synchronous function. No async/await.
 * - Stations only read/write their own state and manipulate ticket Promises.
 * - Gatekeepers complete all state transitions, then tail-call a ticket at the
 *   function end. They never await the ticket.
 * - Ticket capabilities arrive through the constructor bundle; a station
 *   without a capability cannot create that ticket.
 *
 * Host contract (omp 18.20.x):
 * - `pi.on("assistant_message", ...)` runs before persistence, agent context,
 *   and tool dispatch. Scope transitions are processed there.
 * - `pi.on("tool_call", ...)` can block a call with `{ block, reason }`.
 * - `pi.on("context", ...)` returns the outbound message list only.
 * - `ctx.sessionManager` exposes getBranch/appendMessage/branch/
 *   buildSessionContext/appendCustomEntry.
 * - `pi.sendUserMessage(text, { deliverAs: "steer" })` queues a user prompt.
 */

import { currentScope, deferIntent, serializeState } from "../scope/index.mjs";
import {
	applyCollapses,
	appendUserTail,
	beatKey,
	filterRegrets,
	findRegretTarget,
	findToolCallIndex,
	rewriteVibeMessage,
	toolCalls,
} from "../transcript/index.mjs";
import {
	agentPolicy,
	hasSessionInit,
	MAIN_AGENT,
	READ_WRITE_SUBAGENT,
} from "../host/policy.mjs";
import { setAgentMessages } from "../host/capture.mjs";
import {
	firstEvaluationNudge,
	openLedgerNudge,
	relayStatusText,
} from "../relay/index.mjs";
import {
	handleDeferCall,
	handlePinCall,
	handleRegretCall,
	handleScopeCall,
} from "./controls.mjs";
import {
	directDefer,
	directPin,
	directRegret,
	directScope,
	executeDefer,
	executePin,
	executeRegret,
	executeScope,
} from "./execute.mjs";
import { findBeginEntry, foldElder as foldElderInBranch } from "./fold.mjs";
import {
	advanceRelayForHandoff,
	armHandoff,
	finishCompactedHandoff,
	markHandoffPending,
	recordHandoffFailureAt,
	recordLedgerEvaluation,
} from "./handoff-state.mjs";
import {
	onAssistantMessage,
	onAutoCompactionEnd,
	onBeforeAgentStart,
	onContext,
	onMessageEnd,
	onSessionCompact,
	onSessionStop,
	onSessionSwitch,
	onToolCall,
} from "./gates.mjs";
import { controlsIn, parseArgs, processedKey, sameTail } from "./messages.mjs";
import { restoreState, SESSION_STATE_TYPE } from "./restore.mjs";
import { insideScopeNudge, tailText } from "./texts.mjs";

export class SessionStation {
	constructor(manager, pi, tickets, registry) {
		this.manager = manager;
		this.pi = pi;
		this.tickets = tickets;
		this.registry = registry;
		this.state = restoreState(manager);
		this.handled = new Map();
		this.processedCalls = new Set();
		this.processedMessages = new Set();
		this.callGroups = new Map();
		this.nudged = new WeakSet();
		this.needsRebase = false;
		this.lastError = null;
		this.hostBoundaryKey = null;
		this.agentPolicy = null;
		this.relayPromptPendingFor = null;
		this.relayPromptSentFor = null;
		this.handoffExecuting = false;
		this.handoffSwitched = false;
		this.handoffSession = null;
		this.handoffFocus = null;
		this.handoffAdvanced = false;
		this.sessionStopRunning = false;
		this.relayState = true;
		this.todoGrantKey = null;
	}

	// -- Persistence ---------------------------------------------------------

	persist() {
		const manager = this.manager;
		if (!manager || typeof manager.appendCustomEntry !== "function") return;
		try {
			manager.appendCustomEntry(SESSION_STATE_TYPE, serializeState(this.state));
		} catch (error) {
			this.lastError = String(error?.message ?? error);
		}
	}

	// -- Policy --------------------------------------------------------------

	policy(ctx) {
		if (this.agentPolicy !== null) return this.agentPolicy;
		const policy = agentPolicy(ctx);
		// Freeze only a verdict backed by the host's persisted contract. The
		// runtime identity fallback carries no tool grant, so it must be
		// recomputed until `session_init` lands.
		if (policy === MAIN_AGENT) {
			if (ctx?.agent?.kind === "main") this.agentPolicy = policy;
			return policy;
		}
		if (hasSessionInit(ctx)) {
			this.agentPolicy = policy;
			// INVARIANT: relay and `todo` are one decision. The relay starts
			// here, so `todo` must be granted in the same breath.
			this.syncTodo(policy);
		}
		return policy;
	}

	/**
	 * INVARIANT: a session that may run the relay always holds `todo`, and a
	 * session that may not never receives it. `policy(ctx)` is the only
	 * verdict; this method is the only place that acts on it.
	 */
	syncTodo(policy) {
		if (policy !== READ_WRITE_SUBAGENT) return;
		let active = [];
		try {
			active = this.pi?.getActiveTools?.() ?? [];
		} catch {
			active = [];
		}
		if (!Array.isArray(active) || active.includes("todo")) return;
		// A host that filters `todo` out of every setActiveTools call returns
		// the same tool set each time. Retry only when that set changes.
		const key = active.join("\u0000");
		if (key === this.todoGrantKey) return;
		this.todoGrantKey = key;
		void this.tickets.activateTools(active, undefined, false);
	}

	/**
	 * Re-assert the invariant before every model request. The host can install
	 * the session's tool set after the verdict lands, so one grant at verdict
	 * time is not enough. Never duplicate the verdict here.
	 */
	ensureTools(ctx) {
		this.syncTodo(this.policy(ctx));
	}

	/**
	 * The only observable proof that the relay can run: the session really
	 * holds `todo`. A grant request is not proof. omp strips `todo` from every
	 * subagent spawn and filters it again out of every subagent
	 * `setActiveTools` call (task/executor.ts passes `filterActiveTools`), so a
	 * grant can succeed silently and still leave the tool absent.
	 */
	todoReady() {
		try {
			const active = this.pi?.getActiveTools?.();
			return Array.isArray(active) && active.includes("todo");
		} catch {
			return false;
		}
	}

	/**
	 * INVARIANT: the relay runs only while `todo` is actually available.
	 * `policy(ctx)` names the agent tier; `todoReady()` proves the tool. Both
	 * must hold. A read-write subagent whose host filters the tool out stays
	 * relay-off, because a nudge would demand a call the model cannot make.
	 */
	relayOn(ctx) {
		const policy = this.policy(ctx);
		let on;
		if (policy === MAIN_AGENT) on = true;
		else if (policy !== READ_WRITE_SUBAGENT) on = false;
		else on = this.todoReady();
		this.relayState = on;
		return on;
	}

	/**
	 * The latest observable verdict, for synchronous result text. Gates call
	 * `relayOn(ctx)` before any tool result is produced, so this holds a fact
	 * from this turn, not an assumption about a grant.
	 */
	relayReady() {
		return this.relayState;
	}

	// -- Internal helpers ----------------------------------------------------

	setHandled(toolCallId, result) {
		this.handled.set(toolCallId, result);
		if (this.handled.size > 512) {
			const oldest = this.handled.keys().next().value;
			this.handled.delete(oldest);
		}
	}

	deliverSteer(text) {
		if (!text || !this.tickets.canSteer) return false;
		this.tickets.steer(text);
		return true;
	}

	contextMessages() {
		try {
			const context = this.manager?.buildSessionContext?.();
			return Array.isArray(context?.messages) ? context.messages : [];
		} catch {
			return [];
		}
	}

	assistantForToolCall(toolCallId) {
		const messages = this.contextMessages();
		const index = findToolCallIndex(messages, toolCallId);
		if (index < 0) return null;
		return { messages, index, message: messages[index] };
	}

	findBeginEntry(beginToolCallId) {
		return findBeginEntry(this.manager, beginToolCallId);
	}

	foldElder(args) {
		const folded = foldElderInBranch({ manager: this.manager, ...args });
		if (folded.rebased) this.needsRebase = true;
		return folded;
	}

	findRegretTarget(base, currentIndex, scope) {
		return findRegretTarget(this.state, base, currentIndex, scope);
	}

	deferIntent(toolCallId, intent) {
		return deferIntent(this.state, { toolCallId, intent });
	}

	rememberCallGroups(message) {
		if (!message || message.role !== "assistant") return;
		const key = beatKey(message);
		for (const call of toolCalls(message)) {
			if (!this.callGroups.has(call.id)) this.callGroups.set(call.id, key);
		}
		if (this.callGroups.size > 1024) {
			for (const id of this.callGroups.keys()) {
				this.callGroups.delete(id);
				if (this.callGroups.size <= 512) break;
			}
		}
	}

	// -- Message processing ----------------------------------------------------

	processAssistantMessage(message, { persisted = false } = {}) {
		const controls = controlsIn(message);
		if (controls.length === 0) return;
		const key = processedKey(controls);
		if (this.processedMessages.has(key)) return;
		this.processedMessages.add(key);

		const existing = this.contextMessages();
		const firstIndex = findToolCallIndex(existing, controls[0].id);
		const currentPersisted = firstIndex >= 0;
		const base = currentPersisted ? existing : [...existing, message];
		const currentIndex = currentPersisted ? firstIndex : base.length - 1;
		const currentMessage = base[currentIndex] ?? message;

		let changed = false;
		for (const call of controls) {
			if (call.name !== "regret") continue;
			if (this.processedCalls.has(call.id)) continue;
			this.setHandled(call.id, handleRegretCall(this, call, base, currentIndex));
			changed = true;
		}

		const beginIds = new Set(
			controls
				.filter((call) => call.name === "scope" && parseArgs(call).begin != null)
				.map((call) => call.id),
		);
		const hasFunctionalTools = toolCalls(message).some(
			(call) => !CONTROL_TOOLS.has(call.name),
		);

		for (const call of controls) {
			if (call.name === "regret") continue;
			if (this.processedCalls.has(call.id)) continue;
			if (call.name === "pin") {
				this.setHandled(call.id, handlePinCall());
				this.processedCalls.add(call.id);
				continue;
			}
			if (call.name === "defer") {
				this.setHandled(call.id, handleDeferCall(this, call));
				this.processedCalls.add(call.id);
				changed = true;
				continue;
			}
			if (hasFunctionalTools && parseArgs(call).end != null) {
				// Defer closing scope until executeScope so functional tools in the
				// same message still pass their `tool_call` budget check first.
				continue;
			}
			this.setHandled(
				call.id,
				handleScopeCall(this, call, {
					base,
					currentMessage,
					currentPersisted,
					sameMessageBeginIds: beginIds,
				}),
			);
			this.processedCalls.add(call.id);
			changed = true;
		}

		for (const call of controls) {
			if (call.name === "regret") this.processedCalls.add(call.id);
		}
		if (changed) this.persist();
	}

	processControlsForTool(toolCallId) {
		const found = this.assistantForToolCall(toolCallId);
		if (!found) return;
		this.processAssistantMessage(found.message, { persisted: true });
	}

	// -- Execute cores (called by tickets) -------------------------------------

	executeScope(toolCallId, params) {
		return executeScope(this, toolCallId, params);
	}

	executeRegret(toolCallId, params) {
		return executeRegret(this, toolCallId, params);
	}

	executeDefer(toolCallId, params) {
		return executeDefer(this, toolCallId, params);
	}

	executePin(toolCallId, params) {
		return executePin(this, toolCallId, params);
	}

	directScope(toolCallId, params) {
		return directScope(this, toolCallId, params);
	}

	directRegret(toolCallId, params) {
		return directRegret(this, toolCallId, params);
	}

	directDefer(toolCallId, params) {
		return directDefer(this, toolCallId, params);
	}

	directPin(toolCallId, params) {
		return directPin(this, toolCallId, params);
	}

	// -- Nudge -----------------------------------------------------------------

	maybeNudge(message, ctx) {
		if (!message || message.role !== "assistant") return;
		if (!this.relayOn(ctx)) return;
		if (toolCalls(message).length > 0) return;
		if (this.nudged.has(message)) return;
		this.nudged.add(message);
		if (currentScope(this.state)) {
			this.deliverSteer(insideScopeNudge(this.state));
			return;
		}
		const relay = this.state.relay;
		if (!relay) {
			this.deliverSteer(firstEvaluationNudge());
			return;
		}
		if (relay.canStop) return;
		if (relay.handoffPending) {
			// Do not steer here. A steering nudge keeps the turn alive and prevents
			// the host from emitting session_stop, which is the only place where the
			// real handoff runs. The todo result already tells the model to stop.
			return;
		}
		if (!relay.lastLedger) {
			this.deliverSteer(firstEvaluationNudge());
			return;
		}
		// After a handoff, lastLedger still holds the previous holder's empty
		// snapshot. The successor has not evaluated yet, so do not hand off again;
		// require its first todo evaluation first.
		if (relay.generation > 0 && relay.firstEvaluation === null) {
			this.deliverSteer(firstEvaluationNudge());
			return;
		}
		if (relay.lastLedger.empty) {
			this.deliverSteer(relayStatusText(relay, relay.lastLedger, { action: "handoff" }));
			this.markHandoffPending(ctx, { reason: "empty-ledger" });
			return;
		}
		this.deliverSteer(openLedgerNudge(relay, relay.lastLedger));
	}

	// -- Rebase -----------------------------------------------------------------

	maybeRebase(ctx, outbound) {
		if (!this.needsRebase) return;
		const tree = this.contextMessages();
		if (!sameTail(tree, outbound)) return;
		if (setAgentMessages(ctx, tree)) this.needsRebase = false;
	}

	// -- Context transform (sync) -----------------------------------------------

	transformContext(original, ctx) {
		try {
			let messages = filterRegrets(original, this.state.regrets);
			messages = applyCollapses(
				messages,
				this.state.collapses,
				this.state.epoch,
			);
			messages = messages.map(rewriteVibeMessage);
			this.maybeRebase(ctx, messages);
			messages = appendUserTail(messages, tailText(this.state, this.relayOn(ctx)));
			return { messages };
		} catch (error) {
			this.lastError = String(error?.message ?? error);
			try {
				return {
					messages: appendUserTail(original, tailText(this.state, this.relayOn(ctx))),
				};
			} catch {
				return { messages: original };
			}
		}
	}

	// -- Handoff state transitions (sync) ---------------------------------------

	armHandoff() {
		return armHandoff(this);
	}

	advanceRelayForHandoff() {
		return advanceRelayForHandoff(this);
	}

	recordLedgerEvaluation(phases, op, options = {}) {
		return recordLedgerEvaluation(this, phases, op, options);
	}

	recordHandoffFailureAt(error, at) {
		return recordHandoffFailureAt(this, error, at);
	}

	finishCompactedHandoff() {
		return finishCompactedHandoff(this);
	}

	markHandoffPending(ctx, options = {}) {
		return markHandoffPending(this, ctx, options);
	}

	// -- Gatekeepers (sync event entries) ---------------------------------------

	onAssistantMessage(message, ctx) {
		return onAssistantMessage(this, message, ctx);
	}

	onMessageEnd(event, ctx) {
		return onMessageEnd(this, event, ctx);
	}

	onToolCall(event, ctx) {
		return onToolCall(this, event, ctx);
	}

	onContext(messages, ctx) {
		return onContext(this, messages, ctx);
	}

	onSessionStop(ctx) {
		return onSessionStop(this, ctx);
	}

	onSessionSwitch(event, ctx) {
		return onSessionSwitch(this, event, ctx);
	}

	onSessionCompact(ctx) {
		return onSessionCompact(this, ctx);
	}

	onAutoCompactionEnd(event, ctx) {
		return onAutoCompactionEnd(this, event, ctx);
	}

	onBeforeAgentStart(event, ctx) {
		return onBeforeAgentStart(this, event, ctx);
	}
}
