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
	createBracketLedger,
	createUsageLedger,
	pauseClock,
	planStateEntry,
	resumeClock,
	serializeState,
	unreceivedChildren,
} from "../scope/index.mjs";
import {
	adoptLedger,
	conversationKeyOf,
	ledgerFor,
} from "../host/fork-registry.mjs";
import {
	filterAmends,
	findAmendTarget,
	findToolCallIndex,
	applyReceiptFolds,
	lastStructuralCallId,
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
import { contextHeaderOf } from "../host/adapter.mjs";
import { record } from "../host/diagnostics.mjs";
import { createEmptyCatalog } from "../host/pricing.mjs";
import { createAmendOff, createAmendOn } from "../features/amend/index.mjs";
import { createHerdOff, createHerdOn } from "../features/herd/index.mjs";
import { createPinOff, createPinOn } from "../features/pin/index.mjs";
import { handleAmendCall } from "./controls.mjs";
import {
	directAmend,
	executePin,
	executeAmend,
	executeFork,
	executeJoin,
	executeReturn,
} from "./execute.mjs";
import { checkJoinBinding, commitJoin, renderJoinResult } from "./fork-controls.mjs";
import {
	addReceipt,
	attachReport,
	createReceiptRecord,
	foldableReceipts,
	markCollapsed,
} from "../scope/receipts.mjs";
import {
	advanceRelayForHandoff,
	armHandoff,
	captureHandoffReport,
	commitSelfHandoff,
	markInheritedLedgerViewed,
	recordLedgerEvaluation,
	recordNaturalStop,
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
	prepareRequest,
} from "./gates.mjs";
import { controlsIn, processedKey, sameTail } from "./messages.mjs";
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
		this.handoffReport = null;
		this.relayState = true;
		this.todoGrantKey = null;
		this.pendingModelSwitch = null;
		this.modelSwitchInFlight = null;
		// The bracket ledger is session-wide: parent and child live in
		// different agents and must see the same pairing. The scope state owns
		// the tree so a reload restores it, while the registry indexes the live
		// object: a running tree wins, a restored non-empty tree wins over an
		// empty index, and two fresh stations of one conversation share one
		// empty ledger instead of growing two.
		const forkWiring = registry?.forkWiring?.() ?? null;
		this.forkWiring = forkWiring;
		const key = conversationKeyOf(manager ?? null);
		const indexed = forkWiring ? ledgerFor(forkWiring.registry, key) : null;
		const restored = this.state.brackets ?? null;
		const indexedLive = (indexed?.order?.length ?? 0) > 0;
		const restoredLive = (restored?.order?.length ?? 0) > 0;
		this.brackets = indexedLive
			? indexed
			: restoredLive
				? restored
				: (indexed ?? restored ?? createBracketLedger());
		if (forkWiring && !indexedLive) adoptLedger(forkWiring.registry, key, this.brackets);
		this.state.brackets = this.brackets;
		// Attached by the host wiring; null means this station cannot wait.
		this.forkWaitPort = null;
		this.forkReports = new Map();
		this.ownerId = null;
		this.selfForkId = null;
		this.parentOwnerId = null;
		this.usage = createUsageLedger({
			state: this.state,
			contextMessages: () => this.contextMessages(),
			persist: () => this.persist(),
			noteError: (domain, error) => this.noteError(domain, error),
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
		view.handoffReport = null;
		view.todoGrantKey = null;
		view.pendingModelSwitch = null;
		view.modelSwitchInFlight = null;
		view.usage = createUsageLedger({
			state: view.state,
			contextMessages: () => view.contextMessages(),
			persist: () => view.persist(),
			noteError: (domain, error) => view.noteError(domain, error),
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
		// A false answer is a lost state write, not "nothing to do": the anchor
		// returns true when there was nothing owed.
		return this.anchor.persist();
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
		// `relay=none` means no ledger is owed, so the relay nudge and the
		// todo override stay off for every agent tier.
		if (this.registry?.ports?.().relay === "none") {
			this.relayState = false;
			return false;
		}
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

	prepareToolDispatch(message, id, name) {
		this.dispatch.prepare(message, id, name);
		// Waiting on the other bracket is not this branch's work. A join or a
		// return may block for as long as the counterpart needs, so it never
		// carries the branch clock's limit.
		if (name === "scope_join" || name === "scope_return") return false;
		return this.toolTimeLimit() !== null;
	}

	admitToolDispatch(id, name, ctx, receipt = null) {
		if (receipt) {
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
		const verdict = onToolCall(this, { toolCallId: id, toolName: name }, ctx);
		if (verdict) return verdict;
		if (name === "scope_join" || name === "scope_return") return undefined;
		const limitMs = this.toolTimeLimit();
		return limitMs === null ? undefined : { limitMs };
	}

	/** The fork record of this branch, or null at the root. */
	branchRecord() {
		const ledger =
			typeof this.forkLedgerPort === "function" ? this.forkLedgerPort() : null;
		const ownerId =
			typeof this.forkOwnerId === "function" ? this.forkOwnerId() : null;
		return ownerId && ledger ? (ledger.forks?.[ownerId] ?? null) : null;
	}

	/**
	 * Freeze this branch's clock while it waits on another bracket. The root
	 * owns no record, so it has nothing to pause.
	 */
	pauseBranchClock() {
		return pauseClock(this.branchRecord());
	}

	/** Resume the clock and give back exactly the paused span. */
	resumeBranchClock() {
		return resumeClock(this.branchRecord());
	}

	/** 1000 ms once this branch's deadline has passed, else null. */
	toolTimeLimit() {
		const record = this.branchRecord();
		const deadline = record?.deadlineAt;
		if (!Number.isFinite(deadline)) return null;
		const now = Date.now();
		if (now < deadline) {
			// A tool started in normal time may run only up to the deadline
			// plus the one-second chess-clock unit, so the effective limit is
			// exactly deadline + 1s.
			return deadline - now + 1000;
		}
		if (record.overtimeAt === null || record.overtimeAt === undefined) {
			record.overtimeAt = now;
		}
		return 1000;
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

	findAmendTarget(base, currentIndex, boundary = null) {
		return findAmendTarget(
			this.state,
			base,
			currentIndex,
			boundary ?? this.amendBoundary(currentIndex),
		);
	}

	/** The branch boundary an amend may reach, with its ledger and owner. */
	amendBoundary(currentIndex, currentMessage = null) {
		const ledger =
			typeof this.forkLedgerPort === "function" ? this.forkLedgerPort() : null;
		const ownerId =
			typeof this.forkOwnerId === "function" ? this.forkOwnerId() : null;
		const messages = this.contextMessages();
		const boundary = {
			ownerId,
			ledger,
			afterToolCallId: lastStructuralCallId(messages, currentIndex) ?? null,
			record: ownerId && ledger ? (ledger.forks?.[ownerId] ?? null) : null,
		};
		if (currentMessage) boundary.currentMessage = currentMessage;
		return boundary;
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
		const earlyControls = controls;
		let changed = false;
		for (const call of earlyControls) {
			if (call.name !== "amend") continue;
			if (this.processed.hasCall(call.id)) continue;
			const boundary = this.amendBoundary(currentIndex, message);
			this.processed.setHandled(
				call.id,
				handleAmendCall(this, call, base, currentIndex, boundary),
			);
			changed = true;
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

	executeFork(toolCallId, params, ctx) {
		return executeFork(this, toolCallId, params, ctx);
	}

	executeJoin(toolCallId, params, ctx) {
		return executeJoin(this, toolCallId, params, ctx);
	}

	/**
	 * Finish a join whose record was already taken by the waiting ticket.
	 * The station caches the result, so a later replay of the same call sees
	 * the same answer instead of looking for a child that is already closed.
	 */
	finalizeJoin(toolCallId, record, ctx, params = {}, pending = undefined) {
		const elderReport =
			typeof params?.elder_report === "string" ? params.elder_report.trim() : null;
		// The binding travels with the waiting ticket, not from a second read of
		// the chain: a join that waited must file its summary against the
		// receipt the model saw, or refuse.
		commitJoin(this, record, toolCallId, elderReport, pending);
		const result = renderJoinResult(this, record, { closeToolCallId: toolCallId });
		this.processed.setHandled(toolCallId, result);
		this.processed.markCall(toolCallId);
		this.persist();
		return result;
	}

	/** The guard a waiting join runs before every take. */
	joinBindingGuard(expected) {
		return checkJoinBinding(this, expected);
	}

	executeReturn(toolCallId, params, ctx) {
		return executeReturn(this, toolCallId, params, ctx);
	}

	executeAmend(toolCallId, params) {
		return executeAmend(this, toolCallId, params);
	}

	executePin(toolCallId, params) {
		return executePin(this, toolCallId, params);
	}

	// The three session ports read the resolved table on every call, so a
	// switch flipped by the composition root cannot leave a stale
	// implementation behind. Each `on` form writes through this station's
	// persisted state, never a module-level copy.
	pinPort() {
		return this.registry?.ports?.().pin === "off"
			? createPinOff()
			: createPinOn({ notes: this.state.pins });
	}

	amendPort() {
		return this.registry?.ports?.().amend === "off"
			? createAmendOff()
			: createAmendOn({ retired: this.state.amends });
	}

	herdPort() {
		return this.registry?.ports?.().herd === "off"
			? createHerdOff()
			: createHerdOn(this.state);
	}

	directAmend(toolCallId, params) {
		return directAmend(this, toolCallId, params);
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

	// -- Nudge -----------------------------------------------------------------

	maybeNudge(message, ctx) {
		if (!message || message.role !== "assistant") return;
		if (message.stopReason === "aborted" || message.stopReason === "error") return;
		if (!this.relayOn(ctx)) return;
		if (this.nudged.has(message)) return;
		const decision = nudgeDecision(this.state, {
			hasToolCalls: toolCalls(message).length > 0,
		});
		if (decision.kind === "none") return;
		this.nudged.add(message);
		this.deliverSteer(decision.text);
	}

	// -- Rebase -----------------------------------------------------------------

	maybeRebase(ctx, outbound) {
		if (!this.anchor.needsRebase()) return;
		const tree = this.contextMessages();
		if (!sameTail(tree, outbound)) return;
		if (setAgentMessages(ctx, tree)) this.anchor.clearRebase();
	}

	// -- Fork/join receipts (sync) ----------------------------------------------

	/**
	 * Record one successful join. The pending receipt gets the summary this
	 * join carried; the new receipt becomes the newest one at its level.
	 * Both facts live in the persisted scope state, so a reload keeps the
	 * difference between an elder record and the newest one.
	 */
	recordJoinReceipt(entry) {
		const spec = entry && typeof entry === "object" ? entry : {};
		let receipts = Array.isArray(this.state.receipts) ? this.state.receipts : [];
		const pending = spec.pending && typeof spec.pending === "object" ? spec.pending : null;
		if (pending && typeof pending.closeToolCallId === "string") {
			receipts = attachReport(receipts, pending.closeToolCallId, spec.elderReport);
		}
		const record = createReceiptRecord({
			forkToolCallId: spec.forkId,
			...(spec.scopeId ? { scopeId: spec.scopeId } : {}),
			closeToolCallId: spec.closeToolCallId,
			levelKey: spec.levelKey,
			closedOrder: spec.closedOrder,
		});
		if (record) receipts = addReceipt(receipts, record);
		this.state.receipts = receipts;
		return record;
	}

	/** Mark the receipts whose text the projection has shortened. */
	settleReceiptFolds(closeToolCallIds) {
		let receipts = this.state.receipts;
		for (const id of Array.isArray(closeToolCallIds) ? closeToolCallIds : []) {
			receipts = markCollapsed(receipts, id);
		}
		this.state.receipts = receipts;
	}

	// -- Context transform (sync) -----------------------------------------------

	transformContext(original, ctx) {
		try {
			const model = actualModel(ctx);
			const key = modelKey(model);
			let messages = filterAmends(original, this.state.amends);
			// Receipts are the only fold target. The projection shortens an old
			// right bracket without removing its left bracket, so the structure
			// of every fork stays readable and restorable.
			const foldable = foldableReceipts(this.state.receipts);
			if (foldable.length > 0) {
				const folded = applyReceiptFolds(messages, this.state.receipts, { foldable });
				messages = folded.messages;
				if (folded.collapsed.length > 0) this.settleReceiptFolds(folded.collapsed);
			}
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
			messages = messages.map((message) =>
				rewriteVibeMessage(message, this.registry?.ports?.() ?? {}),
			);
			this.maybeRebase(ctx, messages);
			if (key) {
				this.usage.noteSentContext({
					key,
					messages,
					header: contextHeaderOf(ctx),
					frontier:
						outboundFrontier >= 0 ? outboundFrontier + 1 : messages.length,
				});
			}
			return { messages };
		} catch (error) {
			this.noteError("context", error);
			if (error?.code === "FOLD_ROLLBACK_FAILED") {
				// The host catches context-handler errors. Cancel the live Agent
				// too, so a broken journal cannot reach the provider unchanged.
				sessionFor(ctx)?.agent?.abort?.(error);
				throw error;
			}
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

	/** A natural stop is an empty-ledger submission; this records it as one. */
	recordNaturalStop(ctx) {
		return recordNaturalStop(this, ctx);
	}

	/** The successor has looked at the inherited ledger; the requirement ends. */
	markInheritedLedgerViewed() {
		return markInheritedLedgerViewed(this);
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
	 * Build one Skill for the next request. The before-model adapter commits it
	 * before extension context handlers run. Earlier receipts remain unchanged.
	 */
	skillReceipt(ctx, demandVisible) {
		const ledger =
			typeof this.forkLedgerPort === "function" ? this.forkLedgerPort() : null;
		const ownerId =
			typeof this.forkOwnerId === "function" ? this.forkOwnerId() : null;
		const branch = ownerId && ledger ? (ledger.forks?.[ownerId] ?? null) : null;
		const open = ledger ? unreceivedChildren(ledger, ownerId ?? "root").length : 0;
		const text = skillReceiptText(
			this.state,
			this.relayOn(ctx),
			branch,
			open,
			demandVisible,
		);
		return {
			role: "developer",
			content: [{ type: "text", text }],
			attribution: "agent",
			timestamp: Date.now(),
			herdSkill: true,
		};
	}

	prepareRequest(ctx, previous, history) {
		return prepareRequest(this, ctx, previous, history);
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

