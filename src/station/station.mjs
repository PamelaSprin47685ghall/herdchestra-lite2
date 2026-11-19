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
	planStateEntry,
	serializeState,
} from "../scope/index.mjs";
import {
	applyCollapses,
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
import { sessionFor, setAgentMessages } from "../host/capture.mjs";
import { record } from "../host/diagnostics.mjs";
import {
	createEmptyCatalog,
	resolveModelPolicy,
} from "../host/pricing.mjs";
import {
	firstEvaluationNudge,
	handoffEmptyReportNudge,
	openLedgerNudge,
} from "../relay/index.mjs";
import {
	handleDeferCall,
	handleRegretCall,
} from "./controls.mjs";
import {
	directDefer,
	directRegret,
	directScope,
	executeDefer,
	executePin,
	executeRegret,
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
import { insideScopeNudge, skillReceiptText } from "./texts.mjs";

export function receiptTextOf(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export class SessionStation {
	constructor(manager, pi, tickets, registry, pricingCatalog) {
		this.manager = manager;
		this.pi = pi;
		this.tickets = tickets;
		this.registry = registry;
		this.pricingCatalog = pricingCatalog ?? createEmptyCatalog();
		this.state = restoreState(manager);
		// Only a replayable base on disk can anchor a delta. A fresh session,
		// or a chain whose anchor fell outside the replay window, starts with a
		// checkpoint instead.
		this.lastPersisted = hasPersistedBase(manager)
			? serializeState(this.state)
			: null;
		// The entry that carries `lastPersisted`. A delta may only be written
		// while that entry is still on the branch.
		this.lastStateEntryId = this.lastPersisted === null ? null : persistedBaseId(manager);
		this.stateWrites = 0;
		this.handled = new Map();
		this.processedCalls = new Set();
		this.processedMessages = new Set();
		this.callGroups = new Map();
		this.preparingMessage = null;
		this.dispatchMessage = null;
		this.dispatchPositions = new Map();
		this.dispatchHasScope = false;
		this.nudged = new WeakSet();
		this.needsRebase = false;
		this.lastError = null;
		this.hostBoundaryKey = null;
		this.agentPolicy = null;
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

	// -- Usage ledger ---------------------------------------------------------

	// The measured usage facts live in ../scope/usage-ledger.mjs. These
	// accessors keep the station's public surface stable for the modules that
	// read the watermark directly.

	get lastTotalInput() {
		return this.usage.lastTotalInput;
	}

	set lastTotalInput(value) {
		this.usage.lastTotalInput = value;
	}

	get lastOutputTokens() {
		return this.usage.lastOutputTokens;
	}

	set lastOutputTokens(value) {
		this.usage.lastOutputTokens = value;
	}

	get lastUsageCost() {
		return this.usage.lastUsageCost;
	}

	set lastUsageCost(value) {
		this.usage.lastUsageCost = value;
	}

	get lastCtxModel() {
		return this.usage.lastCtxModel;
	}

	set lastCtxModel(value) {
		this.usage.lastCtxModel = value;
	}

	get lastUsageModelKey() {
		return this.usage.lastUsageModelKey;
	}

	set lastUsageModelKey(value) {
		this.usage.lastUsageModelKey = value;
	}

	get sentContext() {
		return this.usage.sentContext;
	}

	set sentContext(value) {
		this.usage.sentContext = value;
	}

	onUsageMessage(message, ctx) {
		this.usage.onMessage(message, ctx);
	}

	// -- Persistence ---------------------------------------------------------

	persist() {
		const manager = this.manager;
		if (!manager || typeof manager.appendCustomEntry !== "function") return;
		try {
			// Anything that rewrites the branch (a fold, an export, a future
			// history tool) drops the entry that anchors `lastPersisted`. A
			// delta written next would replay onto a truncated chain or onto
			// none at all, so the anchor is re-checked here rather than
			// trusted from whichever caller rewrote the branch.
			if (this.lastPersisted !== null && !this.anchorOnBranch()) {
				this.lastPersisted = null;
				this.stateWrites = 0;
				this.lastStateEntryId = null;
			}
			const next = serializeState(this.state);
			const entry = planStateEntry(this.lastPersisted, next, this.stateWrites);
			if (!entry) return;
			const entryId = manager.appendCustomEntry(SESSION_STATE_TYPE, entry);
			this.lastStateEntryId = typeof entryId === "string" ? entryId : null;
			this.lastPersisted = next;
			this.stateWrites = entry.kind === "checkpoint" ? 0 : this.stateWrites + 1;
		} catch (error) {
			this.noteError("persist", error);
		}
	}

	/**
	 * True when the entry carrying `lastPersisted` is still reachable from the
	 * leaf. An unknowable answer forces a checkpoint: one extra full write
	 * costs a state serialization, a lost base costs the whole session state.
	 */
	anchorOnBranch() {
		if (this.lastStateEntryId === null) return true;
		const manager = this.manager;
		if (typeof manager?.getBranch !== "function") return true;
		try {
			const branch = manager.getBranch();
			if (!Array.isArray(branch)) return true;
			for (let index = branch.length - 1; index >= 0; index -= 1) {
				if (branch[index]?.id === this.lastStateEntryId) return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * A fold rewrites the branch from an earlier entry, so every state entry
	 * appended after that point leaves `getBranch()`. A delta written next
	 * would replay onto a truncated chain or onto none at all, and a restart
	 * would come back empty. Drop the baseline and write a checkpoint while
	 * the rebased branch is the live one.
	 */
	rebasePersistedBase() {
		this.lastPersisted = null;
		this.stateWrites = 0;
		this.lastStateEntryId = null;
		this.persist();
	}

	/**
	 * Record one failure. `lastError` stays for compatibility with any reader;
	 * the ring in ../host/diagnostics.mjs keeps the history a single field
	 * loses on the next failure.
	 */
	noteError(domain, error) {
		this.lastError = String(error?.message ?? error);
		record(domain, error);
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
		if (this.dispatchPositions.has(toolCallId)) {
			return this.dispatchMessage;
		}
		if (toolCalls(this.preparingMessage).some((call) => call.id === toolCallId)) {
			return this.preparingMessage;
		}
		return this.assistantForToolCall(toolCallId)?.message;
	}

	prepareScopeDispatch(message, id, name) {
		if (this.dispatchMessage !== message) {
			this.dispatchMessage = message;
			this.dispatchPositions.clear();
			let afterScope = false;
			for (const call of toolCalls(message)) {
				this.dispatchPositions.set(call.id, { name: call.name, afterScope });
				if (call.name === "scope") afterScope = true;
			}
			this.dispatchHasScope = afterScope;
			this.rememberCallGroups(message);
		}
		const position = this.dispatchPositions.get(id);
		if (position) position.name = name;
		return position?.afterScope && !CONTROL_TOOLS.has(name) && name !== "todo";
	}

	deferScopePreflight(id, name) {
		const position = this.dispatchPositions.get(id);
		return position?.name === name && (
			position.afterScope || (name === "todo" && this.dispatchHasScope)
		);
	}

	admitScopeDispatch(id, name, ctx) {
		if (!this.deferScopePreflight(id, name)) return undefined;
		return onToolCall(this, { toolCallId: id, toolName: name }, ctx, true);
	}

	findBeginEntry(beginToolCallId) {
		return findBeginEntry(this.manager, beginToolCallId);
	}

	foldElder(args) {
		const folded = foldElderInBranch({ manager: this.manager, state: this.state, ...args });
		if (folded.rebased) {
			this.needsRebase = true;
			this.rebasePersistedBase();
		}
		return folded;
	}

	/** Fold a whole elder pool in one branch operation. */
	foldBatch(args) {
		const folded = foldBatchInBranch({
			manager: this.manager,
			state: this.state,
			tokensPerChar: this.tokensPerCharFor(this.lastUsageModelKey),
			...args,
		});
		if (folded.rebased) {
			this.needsRebase = true;
			if (this.sentContext) this.sentContext.frontier = Math.min(this.sentContext.frontier, folded.foldStartIdx ?? 0);
			this.rebasePersistedBase();
		}
		return folded;
	}

	/** Observed token density, clamped to a safe band. */
	tokensPerChar(messages) {
		return this.usage.tokensPerChar(messages);
	}

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
		const calls = toolCalls(message);
		const barrier = calls.findIndex((call) => call.name === "scope");
		const earlyControls = barrier < 0 ? controls :
			calls.slice(0, barrier).filter((call) => CONTROL_TOOLS.has(call.name));
		let changed = false;
		for (const call of earlyControls) {
			if (call.name !== "regret") continue;
			if (this.processedCalls.has(call.id)) continue;
			this.setHandled(call.id, handleRegretCall(this, call, base, currentIndex));
			changed = true;
		}

		for (const call of earlyControls) {
			if (call.name === "regret") continue;
			if (this.processedCalls.has(call.id)) continue;
			if (call.name === "defer") {
				this.setHandled(call.id, handleDeferCall(this, call));
				this.processedCalls.add(call.id);
				changed = true;
				continue;
			}
		}

		for (const call of earlyControls) {
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

	executeScope(toolCallId, params, ctx) {
		return executeScope(this, toolCallId, params, ctx);
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

	directRegret(toolCallId, params) {
		return directRegret(this, toolCallId, params);
	}

	directDefer(toolCallId, params) {
		return directDefer(this, toolCallId, params);
	}

	// -- Nudge -----------------------------------------------------------------

	maybeNudge(message, ctx) {
		if (this.state.herdMode) return;
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
			if (!this.handoffReport) {
				this.deliverSteer(handoffEmptyReportNudge());
			}
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
			this.armHandoff(ctx);
			this.deliverSteer(handoffEmptyReportNudge());
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
			const model = actualModel(ctx);
			const key = modelKey(model);
			const pricing = resolveModelPolicy(
				this.pricingCatalog,
				model ? { model } : ctx,
				key === this.lastUsageModelKey ? this.usagePricingHint() : undefined,
			);
			const contextTokens = this.currentContextTokens(original, key);
			const contextWindow = model?.contextWindow ?? pricing.contextWindow;
			this.accrueRentAndFlood(original, { ...pricing, contextWindow }, contextTokens, key);
			let messages = filterRegrets(original, this.state.regrets);
			messages = applyCollapses(
				messages,
				this.state.collapses,
				this.state.epoch,
			);
			messages = messages.map(rewriteVibeMessage);
			this.maybeRebase(ctx, messages);
			if (key) {
				this.sentContext = {
					key,
					chars: sliceChars(messages),
					frontier: messages.length,
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
		const text = skillReceiptText(this.state, this.relayOn(ctx));
		if (last?.herdSkill === true && receiptTextOf(last) === text) return result;
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
