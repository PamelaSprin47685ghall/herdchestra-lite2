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

import {
	createUsageLedger,
	currentScope,
	deferIntent,
	effectiveDeadline,
	planStateEntry,
	serializeState,
} from "../scope/index.mjs";
import {
	applyCollapses,
	beatKey,
	filterAmends,
	findAmendTarget,
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
import { sessionFor, setAgentMessages } from "../host/capture.mjs";
import { record } from "../host/diagnostics.mjs";
import {
	createEmptyCatalog,
	resolveModelPolicy,
} from "../host/pricing.mjs";
import {
	handleDeferCall,
	handleAmendCall,
} from "./controls.mjs";
import {
	directDefer,
	directAmend,
	directScope,
	executeDefer,
	executePin,
	executeAmend,
	executeScope,
} from "./execute.mjs";
import {
	findBeginEntry,
	foldBatch as foldBatchInBranch,
	foldElder as foldElderInBranch,
	netRemovableTokens,
	sliceChars,
} from "./fold.mjs";
import {
	advanceRelayForHandoff,
	armHandoff,
	captureHandoffReport,
	commitSelfHandoff,
	recordLedgerEvaluation,
} from "./handoff-state.mjs";
import {
	onAssistantMessage,
	onBeforeAgentStart,
	onContext,
	onHerdCommand,
	onMessageEnd,
	onSessionCompact,
	onSessionStop,
	onSessionSwitch,
	onToolCall,
} from "./gates.mjs";
import { CONTROL_TOOLS, controlsIn, processedKey, sameTail } from "./messages.mjs";
import {
	modelKey,
	actualModel,
	observeActualModel,
	reconcileActualModel,
	takePendingModelSwitch,
} from "./models.mjs";
import {
	hasPersistedBase,
	persistedBaseId,
	restoreState,
	SESSION_STATE_TYPE,
} from "./restore.mjs";
import { skillReceiptText } from "./texts.mjs";
import { createDispatchTracker } from "./dispatch-tracker.mjs";
import { createPersistenceAnchor } from "./persistence-anchor.mjs";
import { createProcessedLedger } from "./processed-ledger.mjs";
import { nudgeDecision } from "./nudge.mjs";
import {
	clearOwnerRetired as clearOwnerRetirement,
	markOwnerRetired as markOwnerRetirement,
	ownerRetirement,
} from "./retirement.mjs";

export function receiptTextOf(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n");
}

import { loadDoc, render } from "../prompts/index.mjs";

const E = loadDoc("errors");

export class SessionStation {
	constructor(manager, pi, tickets, registry, pricingCatalog) {
		this.manager = manager;
		this.pi = pi;
		this.tickets = tickets;
		this.registry = registry;
		this.pricingCatalog = pricingCatalog ?? createEmptyCatalog();
		this.state = restoreState(manager);
		// A replayable base on disk anchors a delta; a fresh session, or a
		// chain whose anchor fell outside the replay window, starts with a
		// checkpoint instead.
		const hasBase = hasPersistedBase(manager);
		this.anchor = createPersistenceAnchor({
			manager,
			state: () => this.state,
			initialState: hasBase ? serializeState(this.state) : null,
			initialEntryId: hasBase ? persistedBaseId(manager) : null,
			serialize: serializeState,
			plan: planStateEntry,
			type: SESSION_STATE_TYPE,
			noteError: (domain, error) => this.noteError(domain, error),
		});
		this.processed = createProcessedLedger();
		this.dispatch = createDispatchTracker();
		this.nudged = new WeakSet();
		this.lastError = null;
		this.hostBoundaryKey = null;
		this.agentPolicy = null;
		this.ownerRetired = null;
		this.handoffReport = null;
		this.relayState = true;
		this.todoGrantKey = null;
		this.pendingModelSwitch = null;
		this.modelSwitchInFlight = null;
		this.usage = createUsageLedger({
			state: this.state,
			contextMessages: () => this.contextMessages(),
			persist: () => this.persist(),
			foldBatch: (args) => this.foldBatch(args),
			noteError: (domain, error) => this.noteError(domain, error),
			sliceChars,
			netRemovableTokens,
			modelKeyOf: (message) => modelKey(message),
			actualModelOf: (ctx) => actualModel(ctx),
		});
		this.usage.restoreFromBranch(this.manager);
	}

	forkForFlow(flowState, flowManager) {
		const view = Object.create(this);
		view.manager = flowManager ?? this.manager;
		view.state = flowState;
		view.anchor = createPersistenceAnchor({
			manager: view.manager,
			state: () => view.state,
			initialState: null,
			initialEntryId: null,
			serialize: serializeState,
			plan: planStateEntry,
			type: SESSION_STATE_TYPE,
			noteError: (domain, error) => view.noteError(domain, error),
		});
		view.processed = createProcessedLedger();
		view.dispatch = createDispatchTracker();
		view.nudged = new WeakSet();
		view.lastError = null;
		view.hostBoundaryKey = null;
		view.agentPolicy = null;
		view.ownerRetired = null;
		view.handoffReport = null;
		view.todoGrantKey = null;
		view.pendingModelSwitch = null;
		view.modelSwitchInFlight = null;
		view.fissionFlow = null;
		view.pendingFission = null;
		view.usage = createUsageLedger({
			state: view.state,
			contextMessages: () => view.contextMessages(),
			persist: () => view.persist(),
			foldBatch: (args) => view.foldBatch(args),
			noteError: (domain, error) => view.noteError(domain, error),
			sliceChars,
			netRemovableTokens,
			modelKeyOf: (message) => modelKey(message),
			actualModelOf: (ctx) => actualModel(ctx),
		});
		return view;
	}

	// -- Usage ledger ---------------------------------------------------------

	// The measured usage facts live in ../scope/usage-ledger.mjs. Siblings read
	// the ledger's public fields through `station.usage`; there is no forwarding
	// property layer, because a getter per field hides nothing.

	onUsageMessage(message, ctx) {
		this.usage.onMessage(message, ctx);
	}

	// -- Persistence ---------------------------------------------------------

	persist() {
		this.anchor.persist();
	}

	/**
	 * Record one failure. `lastError` stays for compatibility with any reader;
	 * the ring in ../host/diagnostics.mjs keeps the history a single field
	 * loses on the next failure.
	 */
	noteError(domain, error, detail = undefined) {
		this.lastError = String(error?.message ?? error);
		record(domain, error, detail);
	}

	// -- Policy --------------------------------------------------------------

	policy(ctx) {
		if (this.fissionFlow) return MAIN_AGENT;
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

	deliverSteer(text) {
		if (!text || !this.tickets.canSteer) return false;
		this.tickets.steer(text);
		return true;
	}

	/** Send one plain user message; the host starts a turn for it. */
	deliverUserMessage(text) {
		if (!text || !this.tickets.canPrompt) return false;
		this.tickets.prompt(text);
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

	messageForToolCall(toolCallId) {
		return this.dispatch.messageForToolCall(toolCallId) ??
			this.assistantForToolCall(toolCallId)?.message;
	}

	prepareScopeDispatch(message, id, name) {
		const afterScope = this.dispatch.prepare(message, id, name);
		return afterScope && !CONTROL_TOOLS.has(name) && name !== "todo";
	}

	deferScopePreflight(id, name) {
		return this.dispatch.deferPreflight(id, name);
	}

	admitScopeDispatch(id, name, ctx, receipt = null) {
		if (receipt) {
			const scope = currentScope(this.state);
			const deadline = effectiveDeadline(this.state);
			if (
				scope &&
				deadline !== null &&
				Date.now() >= deadline &&
				scope.overtimeAt === null
			) {
				scope.overtimeAt = Date.now();
			}
			if (receipt.limitMs > 0 && receipt.elapsedMs > receipt.limitMs) {
				return {
					block: true,
					reason: render(E["overtime-killed"], {
						elapsed: Math.round(receipt.elapsedMs),
						limit: receipt.limitMs,
					}),
				};
			}
			return undefined;
		}
		if (!this.deferScopePreflight(id, name)) return undefined;
		const verdict = onToolCall(this, { toolCallId: id, toolName: name }, ctx, true);
		if (verdict) return verdict;
			const barrierLimit = this.barrierToolLimit(id);
			if (barrierLimit !== null) return { limitMs: barrierLimit };
		const limitMs = this.toolTimeLimit();
		return limitMs === null ? undefined : { limitMs };
	}

	/**
	 * The barrier's own wall clock, not the enclosing scope's. A trailing call
	 * is the shared first beat of every flow in the batch, so it pays the
	 * batch's `time`, not the scope the owner was already inside.
	 */
	barrierToolLimit(toolCallId) {
		const batch = this.pendingFission;
		if (!batch || batch.retired === true) return null;
		const ids = batch.trailingCallIds;
		if (!Array.isArray(ids) || !ids.includes(toolCallId)) return null;
		if (!Number.isFinite(batch.deadlineAt)) return null;
		const now = Date.now();
		return now < batch.deadlineAt ? batch.deadlineAt - now + 1000 : 1000;
	}

	/** 1000 ms once the innermost scope's deadline has passed, else null. */
	toolTimeLimit() {
		const scope = currentScope(this.state);
		const pending = this.pendingFission;
		const trailingDeadline =
			pending &&
			pending.retired !== true &&
			pending.remainingTrailingIds instanceof Set &&
			pending.remainingTrailingIds.size > 0 &&
			Number.isFinite(pending.deadlineAt)
				? pending.deadlineAt
				: null;
		const scopeDeadline = scope ? effectiveDeadline(this.state) : null;
		const deadlines = [scopeDeadline, trailingDeadline].filter((value) =>
			Number.isFinite(value),
		);
		if (deadlines.length === 0) return null;
		const deadline = Math.min(...deadlines);
		const now = Date.now();
		if (now < deadline) {
			// A tool started in normal time may run only up to the deadline
			// plus the one-second chess-clock unit, so the effective limit is
			// exactly deadline + 1s.
			return deadline - now + 1000;
		}
		if (scope && scope.overtimeAt === null) scope.overtimeAt = now;
		return 1000;
	}

	findBeginEntry(beginToolCallId) {
		return findBeginEntry(this.manager, beginToolCallId);
	}

	foldElder(args) {
		const folded = foldElderInBranch({ manager: this.manager, state: this.state, ...args });
		if (folded.rebased) {
			this.anchor.rebase();
		}
		return folded;
	}

	/** Fold a whole elder pool in one branch operation. */
	foldBatch(args) {
		const folded = foldBatchInBranch({
			manager: this.manager,
			state: this.state,
			tokensPerChar: this.tokensPerCharFor(this.usage.lastUsageModelKey),
			...args,
		});
		if (folded.rebased) {
			this.pruneAmends();
			const sent = this.usage.sentContext;
			if (sent) sent.frontier = Math.min(sent.frontier, folded.foldStartIdx ?? 0);
			this.anchor.rebase();
		}
		return folded;
	}

	/**
	 * Drop amend keys whose assistant beat is no longer on the branch. A fold
	 * removes whole beats, so a dead key would otherwise ride every checkpoint
	 * for the rest of the session.
	 */
	pruneAmends() {
		if (this.state.amends.length === 0) return 0;
		const live = new Set();
		for (const message of this.contextMessages()) {
			if (message?.role === "assistant") live.add(beatKey(message));
		}
		const kept = this.state.amends.filter((key) => live.has(key));
		const dropped = this.state.amends.length - kept.length;
		if (dropped > 0) this.state.amends = kept;
		return dropped;
	}

	/** Observed token density, clamped to a safe band. */
	tokensPerCharFor(key) {
		return this.usage.tokensPerCharFor(key);
	}

	/** Live outbound watermark from the last usage plus fresh pending messages. */
	currentContextTokens(messages, key) {
		return this.usage.currentContextTokens(messages, key);
	}

	/** True when a message already carries the usage that closes a scope. */
	usageArrivedFor(message) {
		return this.usage.usageArrivedFor(message);
	}

	usagePricingHint() {
		return this.usage.pricingHint();
	}

	resetUsageWatermark() {
		this.usage.resetWatermark();
	}

	/** After a fold, shift younger baselines down by the reclaimed tokens. */
	rebaseBaselines(folded) {
		this.usage.rebase(folded);
	}

	/** Accrue per-step cache rent and flood the pools at the 90% watermark. */
	accrueRentAndFlood(original, pricing, contextTokens, key) {
		return this.usage.accrue(original, pricing, contextTokens, key);
	}

	findAmendTarget(base, currentIndex, scope) {
		return findAmendTarget(this.state, base, currentIndex, scope);
	}

	deferIntent(toolCallId, intent) {
		return deferIntent(this.state, { toolCallId, intent });
	}

	// -- Message processing ----------------------------------------------------

	processAssistantMessage(message, { persisted = false } = {}) {
		const controls = controlsIn(message);
		if (controls.length === 0) return;
		const key = processedKey(controls);
		if (this.processed.hasMessage(key)) return;
		this.processed.markMessage(key);

		const existing = this.contextMessages();
		const firstIndex = findToolCallIndex(existing, controls[0].id);
		const currentPersisted = firstIndex >= 0;
		const base = currentPersisted ? existing : [...existing, message];
		const currentIndex = currentPersisted ? firstIndex : base.length - 1;
		const calls = toolCalls(message);
		const barrier = calls.findIndex((call) => call.name === "scope");
		const earlyControls = barrier < 0 ? controls :
			calls.slice(0, barrier).filter((call) => CONTROL_TOOLS.has(call.name));
		let changed = false;
		for (const call of earlyControls) {
			if (call.name !== "amend") continue;
			if (this.processed.hasCall(call.id)) continue;
			this.processed.setHandled(call.id, handleAmendCall(this, call, base, currentIndex));
			changed = true;
		}

		for (const call of earlyControls) {
			if (call.name === "amend") continue;
			if (this.processed.hasCall(call.id)) continue;
			if (call.name === "defer") {
				this.processed.setHandled(call.id, handleDeferCall(this, call));
				this.processed.markCall(call.id);
				changed = true;
				continue;
			}
		}

		for (const call of earlyControls) {
			if (call.name === "amend") this.processed.markCall(call.id);
		}
		if (changed) this.persist();
	}

	processControlsForTool(toolCallId) {
		const found = this.assistantForToolCall(toolCallId);
		if (!found) return;
		this.processAssistantMessage(found.message, { persisted: true });
	}

	// -- Execute cores (called by tickets) -------------------------------------

	executeScope(toolCallId, params, ctx) {
		return executeScope(this, toolCallId, params, ctx);
	}

	executeAmend(toolCallId, params) {
		return executeAmend(this, toolCallId, params);
	}

	executeDefer(toolCallId, params) {
		return executeDefer(this, toolCallId, params);
	}

	executePin(toolCallId, params) {
		return executePin(this, toolCallId, params);
	}

	directScope(toolCallId, params, ctx) {
		return directScope(this, toolCallId, params, ctx);
	}

	observeActualModel(ctx) {
		observeActualModel(this, ctx);
	}

	takePendingModelSwitch(ctx) {
		return takePendingModelSwitch(this, ctx);
	}

	reconcileActualModel(ctx, req, outcome) {
		return reconcileActualModel(this, ctx, req, outcome);
	}

	directAmend(toolCallId, params) {
		return directAmend(this, toolCallId, params);
	}

	directDefer(toolCallId, params) {
		return directDefer(this, toolCallId, params);
	}

	// -- Nudge -----------------------------------------------------------------

	maybeNudge(message, ctx) {
		if (!message || message.role !== "assistant") return;
		// Flow completion is managed by the fission scheduler, not the relay.
		if (this.fissionFlow) return;
		if (!this.relayOn(ctx)) return;
		if (this.nudged.has(message)) return;
		const decision = nudgeDecision(this.state, {
			hasToolCalls: toolCalls(message).length > 0,
			hasHandoffReport: Boolean(this.handoffReport),
		});
		if (decision.kind === "none") return;
		this.nudged.add(message);
		if (decision.kind === "handoff") this.armHandoff(ctx);
		this.deliverSteer(decision.text);
	}

	// -- Rebase -----------------------------------------------------------------

	maybeRebase(ctx, outbound) {
		if (!this.anchor.needsRebase()) return;
		const tree = this.contextMessages();
		if (!sameTail(tree, outbound)) return;
		if (setAgentMessages(ctx, tree)) this.anchor.clearRebase();
	}

	// -- Context transform (sync) -----------------------------------------------

	transformContext(original, ctx) {
		try {
			const model = actualModel(ctx);
			const key = modelKey(model);
			const pricing = resolveModelPolicy(
				this.pricingCatalog,
				model ? { model } : ctx,
				key === this.usage.lastUsageModelKey ? this.usagePricingHint() : undefined,
			);
			const contextTokens = this.currentContextTokens(original, key);
			const contextWindow = model?.contextWindow ?? pricing.contextWindow;
			this.accrueRentAndFlood(original, { ...pricing, contextWindow }, contextTokens, key);
			let messages = filterAmends(original, this.state.amends);
			messages = applyCollapses(
				messages,
				this.state.collapses,
				this.state.epoch,
			);
			// `messages` is the outbound list: amends removed entries and
			// collapses replaced whole intervals, so its length is not a
			// position in the branch. The economics compare a cache's
			// `cachedUntilPos` against branch indexes, so record the highest
			// branch position the provider actually saw.
			let outboundFrontier = -1;
			for (const message of messages) {
				const at = original.indexOf(message);
				if (at > outboundFrontier) outboundFrontier = at;
			}
			messages = messages.map(rewriteVibeMessage);
			this.maybeRebase(ctx, messages);
			if (key) {
				this.usage.sentContext = {
					key,
					chars: sliceChars(messages),
					frontier:
						outboundFrontier >= 0 ? outboundFrontier + 1 : messages.length,
				};
			}
			return { messages };
		} catch (error) {
			this.noteError("context", error);
			return { messages: original };
		}
	}

	// -- Handoff state transitions (sync) ---------------------------------------

	armHandoff(ctx) {
		return armHandoff(this, ctx);
	}

	captureHandoffReport(text) {
		return captureHandoffReport(this, text);
	}

	commitSelfHandoff(ctx, report) {
		return commitSelfHandoff(this, ctx, report);
	}

	advanceRelayForHandoff(options = {}) {
		return advanceRelayForHandoff(this, options);
	}

	recordLedgerEvaluation(phases, op, options = {}) {
		return recordLedgerEvaluation(this, phases, op, options);
	}

	// -- Owner retirement gate ------------------------------------------------

	markOwnerRetired(request) {
		return markOwnerRetirement(this, request);
	}

	clearOwnerRetired(batchId) {
		return clearOwnerRetirement(this, batchId);
	}

	ownerRetirement(ctx) {
		return ownerRetirement(this, ctx);
	}

	// -- Gatekeepers (sync event entries) ---------------------------------------

	onHerdCommand(args) {
		return onHerdCommand(this, args);
	}

	onAssistantMessage(message, ctx) {
		return onAssistantMessage(this, message, ctx);
	}

	onMessageEnd(event, ctx) {
		return onMessageEnd(this, event, ctx);
	}

	onToolCall(event, ctx) {
		return onToolCall(this, event, ctx);
	}

	/**
	 * Build the dynamic skill message for this turn. The hack-context wrapper
	 * persists it into session history, so the request and the history stay in
	 * sync. Reuse an identical trailing receipt to stay idempotent within a turn.
	 */
	skillReceipt(ctx) {
		const text = skillReceiptText(this.state, this.relayOn(ctx));
		return {
			role: "developer",
			content: [{ type: "text", text }],
			attribution: "agent",
			timestamp: Date.now(),
			herdSkill: true,
		};
	}

	withSkillReceipt(original, result, ctx) {
		const messages = Array.isArray(result?.messages) ? result.messages : original;
		const last = messages.at(-1);
		// A trailing receipt means nothing has been said since the last one. The
		// same turn can call the context handler twice, and the receipt's clock
		// line changes across a second boundary; comparing text would then append
		// a second Skill and hand the provider a prefix it never cached. Reuse the
		// message as is, timestamp included.
		if (last?.herdSkill === true) return result;
		const skill = this.skillReceipt(ctx);
		return { ...result, messages: [...messages, skill] };
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

	onBeforeAgentStart(event, ctx) {
		return onBeforeAgentStart(this, event, ctx);
	}
}

