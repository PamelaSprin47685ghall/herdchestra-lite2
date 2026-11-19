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
	currentScope,
	deferIntent,
	findActivePools,
	modelCacheFor,
	serializeState,
	touchModelCache,
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
import { entryUsage, totalInput, usageSnapshot } from "../host/usage.mjs";
import {
	charsToTokens,
	createEmptyCatalog,
	resolveModelPolicy,
} from "../host/pricing.mjs";
import {
	firstEvaluationNudge,
	openLedgerNudge,
} from "../relay/index.mjs";
import {
	handleDeferCall,
	handlePinCall,
	handleRegretCall,
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
	rememberHandoffSession,
	recordHandoffFailureAt,
	recordLedgerEvaluation,
} from "./handoff-state.mjs";
import {
	onAssistantMessage,
	onBeforeAgentStart,
	onContext,
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
import { restoreState, SESSION_STATE_TYPE } from "./restore.mjs";
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
		this.handoffPromise = null;
		this.gatedAgentHooks = new WeakSet();
		this.handoffSession = null;
		this.relayState = true;
		this.todoGrantKey = null;
		// Measured usage baseline. Populated from live messages and restored
		// from the branch tail so a session reload (-r) keeps the watermark.
		this.lastTotalInput = null;
		this.lastOutputTokens = 0;
		this.lastUsageCost = null;
		this.lastCtxModel = null;
		this.lastUsageModelKey = null;
		this.pendingModelSwitch = null;
		this.modelSwitchInFlight = null;
		this.recordedUsageMessages = new WeakSet();
		this.sentContext = null;
		this.restoreUsageFromBranch();
	}

	// -- Usage baseline -------------------------------------------------------

	/** Recover the most recent usage from the persisted branch tail. */
	restoreUsageFromBranch() {
		try {
			const branch = this.manager?.getBranch?.();
			if (!Array.isArray(branch)) return;
			for (let index = branch.length - 1; index >= 0; index -= 1) {
				const entry = branch[index];
				const message = entry?.message;
				const usage = entryUsage(entry);
				if (!usage) continue;
				const snap = usageSnapshot(usage);
				const tIn = totalInput(snap);
				this.lastTotalInput = tIn;
				this.lastUsageModelKey = modelKey(message);
				this.lastOutputTokens = snap.output;
				this.lastUsageCost = usage.cost ?? null;
				for (const scope of this.state.scopes ?? []) {
					if (scope.baseInputTokens === null || scope.baseInputTokens === undefined) {
						scope.baseInputTokens = tIn;
						scope.baseModelKey = this.lastUsageModelKey;
					}
				}
				break;
			}
		} catch {
			// A host without a branch keeps the null baseline.
		}
	}

	/**
	 * Synchronously fold one assistant usage payload into the station's live
	 * baseline. Called at the head of assistant_message, message_end, and the
	 * extra message_end listener. Idempotent per message object.
	 */
	onUsageMessage(message, ctx) {
		if (!message || message.role !== "assistant") return;
		try {
			if (!message.usage || this.recordedUsageMessages.has(message)) return;
			this.recordedUsageMessages.add(message);
			const snap = usageSnapshot(message.usage);
			const tIn = totalInput(snap);
			const live = actualModel(ctx) ?? this.lastCtxModel;
			const key = message.provider ? modelKey(message) : modelKey(live) ?? modelKey(message);
			this.lastUsageModelKey = key;
			this.lastTotalInput = tIn;
			this.lastOutputTokens = snap.output;
			this.lastUsageCost = message.usage.cost ?? null;
			if (key) {
				const messages = this.contextMessages();
				const index = messages.findLastIndex((item) => item === message ||
					(item?.role === "assistant" && message.timestamp != null && item.timestamp === message.timestamp &&
						(modelKey(item) ?? key) === key));
				const sent = this.sentContext;
				const frontier = index < 0 ? messages.length : index;
				const chars = sent?.key === key ? sent.chars : sliceChars(index < 0 ? messages : messages.slice(0, index));
				this.sentContext = null;
				touchModelCache(this.state, key, {
					cachedUntilPos: sent?.key === key ? Math.min(frontier, sent.frontier) : frontier,
					lastUsedAt: Date.now(),
					tokensPerChar: chars > 0 && tIn > 0 ? Math.min(0.8, Math.max(0.15, tIn / chars)) :
						modelCacheFor(this.state, key)?.tokensPerChar ?? 0.3,
				});
			}
			const callIds = new Set(toolCalls(message).map((call) => call.id));
			for (const scope of this.state.scopes ?? []) {
				if (callIds.has(scope.beginToolCallId)) continue;
				if (scope.baseInputTokens === null || scope.baseInputTokens === undefined) {
					scope.baseInputTokens = tIn;
					scope.baseModelKey = key;
				}
			}
			// A tool_call may close a scope before its assistant usage arrives.
			// Complete the deferred measured interior once usage is visible.
			const collapses = this.state.collapses ?? [];
			for (let index = collapses.length - 1; index >= 0; index -= 1) {
				const record = collapses[index];
				if (record.endInputTokensPending !== true) continue;
				if (!callIds.has(record.endToolCallId)) continue;
				record.endInputTokens = tIn;
				const base = record.baseInputTokens;
				record.measuredModelKey = key;
				record.interiorTokens =
					key && typeof base === "number" && record.baseModelKey === key
						? Math.max(0, tIn - base)
						: Number.isFinite(record.interiorChars)
							? Math.ceil(charsToTokens(record.interiorChars, this.tokensPerCharFor(key)))
							: null;
				record.endInputTokensPending = false;
				for (const scope of this.state.scopes ?? []) {
					if (
						scope.preBeginInputTokens === null ||
						scope.preBeginInputTokens === undefined
					) {
						scope.preBeginInputTokens = tIn;
					}
				}
			}
			this.persist();
		} catch (error) {
			this.lastError = String(error?.message ?? error);
		}
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
		if (folded.rebased) this.needsRebase = true;
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
		}
		return folded;
	}

	/** Observed token density, clamped to a safe band. */
	tokensPerChar(messages) {
		const totalIn = this.lastTotalInput;
		if (!Number.isFinite(totalIn) || totalIn <= 0) return 0.3;
		const source = Array.isArray(messages) ? messages : this.contextMessages();
		const chars = sliceChars(source);
		if (!(chars > 0)) return 0.3;
		const rate = totalIn / chars;
		return Math.min(0.8, Math.max(0.15, rate));
	}

	tokensPerCharFor(key) {
		return key ? modelCacheFor(this.state, key)?.tokensPerChar ?? 0.3 : this.tokensPerChar();
	}

	/** Live outbound watermark from the last usage plus fresh pending messages. */
	currentContextTokens(messages, key = this.lastUsageModelKey) {
		const source = Array.isArray(messages) ? messages : this.contextMessages();
		const tpc = this.tokensPerCharFor(key);
		if (!Number.isFinite(this.lastTotalInput) || (key && key !== this.lastUsageModelKey)) {
			return charsToTokens(sliceChars(source), tpc);
		}
		let pendingChars = 0;
		let usageIndex = -1;
		for (let index = 0; index < source.length; index += 1) {
			if (source[index]?.role === "assistant" && source[index]?.usage) usageIndex = index;
		}
		for (let index = usageIndex + 1; index < source.length; index += 1) {
			if (source[index]?.role === "custom") continue;
			pendingChars += sliceChars([source[index]]);
		}
		return (
			this.lastTotalInput +
			(Number.isFinite(this.lastOutputTokens) ? this.lastOutputTokens : 0) +
			charsToTokens(pendingChars, tpc)
		);
	}

	/** True when a message already carries the usage that closes a scope. */
	usageArrivedFor(message) {
		return Boolean(message?.usage) || this.recordedUsageMessages.has(message);
	}

	usagePricingHint() {
		return this.lastUsageCost ? { usage: { cost: this.lastUsageCost } } : undefined;
	}

	resetUsageWatermark() {
		this.lastTotalInput = null;
		this.lastOutputTokens = 0;
		if (this.sentContext) this.sentContext.frontier = 0;
	}

	/** After a fold, shift younger baselines down by the reclaimed tokens. */
	rebaseBaselines(folded) {
		if (!folded || typeof folded.savedTokens !== "number" || folded.savedTokens <= 0) return;
		const saved = folded.savedTokens;
		for (const scope of this.state.scopes ?? []) {
			const orderMatch = /^scope-(\d+)$/.exec(String(scope.id ?? ""));
			const order = orderMatch ? Number(orderMatch[1]) : 0;
			if (Number.isInteger(folded.maxOrder) && order <= folded.maxOrder) continue;
			if (this.lastUsageModelKey && scope.baseModelKey === this.lastUsageModelKey && Number.isFinite(scope.baseInputTokens)) {
				scope.baseInputTokens = Math.max(0, scope.baseInputTokens - saved);
			}
		}
		if (Number.isFinite(this.lastTotalInput)) {
			this.lastTotalInput = Math.max(0, this.lastTotalInput - saved);
		}
	}

	/** Accrue per-step cache rent and flood the pools at the 90% watermark. */
	accrueRentAndFlood(original, pricing, contextTokens, key) {
		const pools = findActivePools(this.state);
		if (pools.length === 0) return false;
		const tpc = this.tokensPerCharFor(key);
		const pHit = Number.isFinite(pricing?.pHit) ? Math.max(0, pricing.pHit) : 1e-6;
		let dirty = false;
		for (const group of pools) {
			for (const record of group.pool) {
				const rent = netRemovableTokens(record, tpc, key) * pHit;
				if (rent > 0) {
					record.paidRentCost = (Number.isFinite(record.paidRentCost) ? record.paidRentCost : 0) + rent;
					dirty = true;
				}
			}
		}
		const cw = Number.isFinite(pricing?.contextWindow) ? pricing.contextWindow : null;
		const emergency = cw && Number.isFinite(contextTokens) && contextTokens >= 0.9 * cw;
		if (emergency) {
			const tree = Array.isArray(original) ? original : this.contextMessages();
			const batch = pools.flatMap(({ pool }) => pool).sort((a, b) => a.order - b.order);
			const folded = this.foldBatch({ batch, base: tree, epoch: this.state.epoch });
			if (folded.rebased) {
				this.rebaseBaselines(folded);
				dirty = true;
			}
		}
		if (dirty) this.persist();
		return dirty;
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
			// Leave the next request to the successor. Do not queue a nudge.
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
			this.armHandoff();
			this.rememberHandoffSession(ctx);
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
			this.lastError = String(error?.message ?? error);
			return { messages: original };
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

	rememberHandoffSession(ctx) {
		rememberHandoffSession(this, ctx);
	}

	ensureModelCallGate(ctx, gateTicket, resolvedSession = null) {
		if (typeof gateTicket !== "function") return false;
		const session = resolvedSession ?? this.handoffSession ?? null;
		const agent = session?.agent ?? null;
		if (!agent || typeof agent.addBeforeModelCallHook !== "function") return false;
		if (this.gatedAgentHooks.has(agent)) return true;
		this.gatedAgentHooks.add(agent);
		agent.addBeforeModelCallHook((signal, context) =>
			gateTicket(this, session, signal, context, ctx),
		);
		return true;
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
