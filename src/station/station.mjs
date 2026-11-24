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
 * - a session token exposes getBranch/appendMessage/branch/
 *   buildSessionContext/appendCustomEntry.
 * - `pi.sendUserMessage(text, { deliverAs: "steer" })` queues a user prompt.
 */

import {
	createBracketLedger,
	abandonRequest,
	beginRequest,
	createTurnClock,
	createUsageLedger,
	finishRequest,
	markLedgerStructDirty,
	normalizeTotals,
	planStateEntry,
	serializeState,
	serializeStateShared,
	forkOf,
	unreceivedChildren,
} from "../scope/index.mjs";
import { takeReturnNudge } from "../scope/return-nudge.mjs";
import { recordTurnSample } from "../scope/turn-stats.mjs";
import { notePanhandled } from "../scope/panhandle.mjs";
import {
	adoptLedger,
	conversationKeyOf,
	ledgerFor,
} from "../scope/fork-registry.mjs";

import {
	findAmendTarget,
	findToolCallIndex,
	lastStructuralCallId,
	toolCalls,
} from "../transcript/index.mjs";
import {
	agentPolicy,
	hasSessionInit,
	MAIN_AGENT,
	READ_WRITE_SUBAGENT,
} from "../core/policy.mjs";
import { PORT_NAMES } from "../core/ports/registry.mjs";
import { IMPLEMENTATION_KEYS, missingPortsError } from "./ports-contract.mjs";
import { handleAmendCall } from "./controls.mjs";
import {
	directAmend,
	executePin,
	executeAmend,
	executeContext,
	executeFork,
	executeJoin,
	executeReturn,
	executeSend,
} from "./execute.mjs";
import {
	confirmJoinPersistence,
	renderJoinResult,
} from "./fork-controls.mjs";
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
	cancelDescendants,
	onAssistantMessage,
	onBeforeAgentStart,
	onContext,
	onAutopilotCommand,
	onMessageEnd,
	onSessionCompact,
	onSessionStop,
	onSessionSwitch,
	onToolCall,
	prepareRequest,
} from "./gates.mjs";
import { controlsIn, processedKey } from "./messages.mjs";
import {
	projectContext,
	shouldRebase,
} from "./domain/context.mjs";
import {
	createToolCallLedger,
	processedOf,
} from "./domain/tool-call-ledger.mjs";
import {
	modelKey,
	modelKeyOf,
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
import { createPersistenceAnchor } from "./persistence-anchor.mjs";
import { nudgeDecision } from "./nudge.mjs";

export function receiptTextOf(message) {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * The amend arguments a control call carries, or null when it carries none.
 * A retired `amend` call is still in old transcripts, so the scan path reads
 * both names; the new name nests the same object under `amend`.
 */
function amendArgumentsOf(call) {
	if (call?.name === "amend") return call.arguments ?? {};
	if (call?.name !== "scope_context") return null;
	let args = call.arguments;
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			return null;
		}
	}
	return args?.amend ?? null;
}

/**
 * A station can receive capabilities from two places: the composition root's
 * bag (through the registry) and the constructor argument. They are the same
 * object in production; a test double may supply only one side, so the two are
 * merged with the registry winning on a shared key.
 */
function mergeHost(fromRegistry, fromConstructor) {
	if (!fromRegistry) return fromConstructor ?? null;
	if (!fromConstructor) return fromRegistry;
	return { ...fromConstructor, ...fromRegistry };
}

/**
 * Read one host shape. The interface is grouped by role (`session`, `model`,
 * `accounting`, `fork`, `report`); a double written against the older flat bag
 * is widened here so no station carries a second convention.
 */
export function shapeHost(host) {
	const source = host && typeof host === "object" ? host : {};
	const session = source.session ?? {};
	const model = source.model ?? {};
	const accounting = source.accounting ?? {};
	const fork = source.fork ?? {};
	const report = source.report ?? {};
	const pick = (grouped, flat) => grouped ?? flat;
	const pricing = pick(accounting.pricing, source.pricing);
	return {
		session: {
			managerOf: pick(session.managerOf, source.managerOf),
			conversationKey: pick(session.conversationKey, source.conversationKeyOf),
			branch: pick(session.branch, source.branchOf),
			agent: pick(session.agent, source.agentOf),
			activeTools: pick(session.activeTools, source.activeTools),
			header: pick(session.header, source.contextHeaderOf),
			setMessages: pick(session.setMessages, source.setAgentMessages),
			appendHistory: pick(session.appendHistory, source.appendHistoryMessage),
			abort: (ctx, error) => source.sessionFor?.(ctx)?.agent?.abort?.(error),
		},
		model: {
			of: pick(model.of, source.modelOf),
			thinkingOf: pick(model.thinkingOf, source.thinkingOf),
			parseSpec: pick(model.parseSpec, source.preparseModelSpec),
			capabilities: pick(model.capabilities, source.capabilities),
			query: pick(model.query, source.models),
		},
		accounting: {
			usage: pick(accounting.usage, source.usage),
			pricing: pricing && {
				...pricing,
				emptyCatalog: pricing?.emptyCatalog ?? source.createEmptyCatalog,
			},
		},
		fork: {
			wiring: pick(fork.wiring, source.forkWiring),
			attachBaseForkPorts: pick(fork.attachBaseForkPorts, source.attachBaseForkPorts),
			identityForAgent: pick(fork.identityForAgent, source.identityForAgent),
			agentIdOf: pick(fork.agentIdOf, source.agentIdOf),
			selectStopStation: pick(fork.selectStopStation, source.selectStopStation),
			sameManager: pick(fork.sameManager, source.sameManager),
			ledgerFor: pick(fork.ledgerFor, source.ledgerFor),
			adoptLedger: pick(fork.adoptLedger, source.adoptLedger),
		},
		report: { record: pick(report.record, source.record) },
	};
}

export class SessionStation {
	constructor(manager, host, tickets, registry, pricingCatalog) {
		this.manager = manager;
		this.host = shapeHost(mergeHost(registry?.host?.(), host));
		this.tickets = tickets;
		this.registry = registry;
		this.pricingCatalog =
			pricingCatalog ?? this.host?.accounting?.pricing?.emptyCatalog?.() ?? null;
		this.state = restoreState(manager, this.host?.report?.record);
		// A replayable base on disk anchors a delta; a fresh session, or a
		// chain whose anchor fell outside the replay window, starts with a
		// checkpoint instead.
		const hasBase = hasPersistedBase(manager);
		this.anchor = createPersistenceAnchor({
			manager,
			state: () => this.state,
			initialState: hasBase ? serializeState(this.state) : null,
			initialEntryId: hasBase ? persistedBaseId(manager) : null,
			serialize: serializeStateShared,
			plan: planStateEntry,
			type: SESSION_STATE_TYPE,
			noteError: (domain, error) => this.noteError(domain, error),
		});
		// The host may deliver the same tool call through the `tool_call` event
		// and through dispatch admission. The ledger caches the first verdict so
		// the second entry sees the same answer and the branch is charged once.
		this.toolCallLedger = createToolCallLedger();
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
		const key = (this.host?.session?.conversationKey ?? conversationKeyOf)(manager ?? null);
		const indexed =
			forkWiring && key !== null
				? ((this.host?.fork?.ledgerFor ?? ledgerFor)(forkWiring.registry, key) ?? null)
				: null;
		const restored = this.state.brackets ?? null;
		const indexedLive = (indexed?.order?.length ?? 0) > 0;
		const restoredLive = (restored?.order?.length ?? 0) > 0;
		const chosen = indexedLive
			? indexed
			: restoredLive
				? restored
				: (indexed ?? restored ?? createBracketLedger());
		// The tree choice stays order-based, but the turn samples must survive a
		// reload even when the restored tree has no open forks. Fill an empty
		// chosen ledger from the other candidate; never sum two live samples.
		const other = chosen === indexed ? restored : indexed;
		if (chosen && other && chosen !== other) {
			const chosenTotals = normalizeTotals(chosen.totals);
			const otherTotals = normalizeTotals(other.totals);
			const chosenHasSamples = chosenTotals.turns > 0 || chosenTotals.turnMs > 0;
			const otherHasSamples = otherTotals.turns > 0 || otherTotals.turnMs > 0;
			if (!chosenHasSamples && otherHasSamples) {
				chosen.totals = otherTotals;
				// The shared serializer reuses the previous copy of a ledger, so
				// a replaced totals object must be announced before the next write.
				markLedgerStructDirty(chosen);
			}
		}
		this.brackets = chosen;
		if (forkWiring && key !== null && (chosen !== indexed || !indexedLive)) {
			(this.host?.fork?.adoptLedger ?? adoptLedger)(forkWiring.registry, key, this.brackets);
		}
		this.state.brackets = this.brackets;
		// Attached by the host wiring; null means this station cannot wait.
		this.forkWaitPort = null;
		this.forkReports = new Map();
		this.selfForkId = null;
		this.parentOwnerId = null;
		// Request windows are process-local. A reload keeps the two totals on the
		// ledger and starts the next request from an empty clock.
		this.turnClock = createTurnClock();
		this.turnModelKey = "";
		// assistant_message and message_end can both deliver the same object.
		// Identity, not startedAt, is what stops a late copy from closing the
		// next request.
		this.countedRequests = new WeakSet();
		this.usage = createUsageLedger({
			state: this.state,
			contextMessages: () => this.contextMessages(),
			persist: () => this.persist(),
			noteError: (domain, error) => this.noteError(domain, error),
			modelKeyOf,
			actualModelOf: (ctx) => actualModel(ctx, this.host),
			usage: this.host?.accounting?.usage ?? null,
			pricing: this.host?.accounting?.pricing ?? null,
		});
		this.usage.restoreFromBranch(this.manager);
		// The composition root builds one complete bundle; bind each
		// implementation to this station's persisted state exactly once. A
		// station without a complete bundle cannot start: a fallback here
		// would be a second composition root and would hide the missing
		// capability until the port was first used.
		const implementations = registry?.implementations?.();
		const missing = IMPLEMENTATION_KEYS.filter(
			(key) => !implementations?.[key],
		);
		if (missing.length > 0) throw missingPortsError(missing);
		const portTable = registry?.ports?.();
		const missingNames = PORT_NAMES.filter(
			(name) => typeof portTable?.[name] !== "string",
		);
		if (missingNames.length > 0) throw missingPortsError(missingNames);
		this.portTable = Object.isFrozen(portTable)
			? portTable
			: Object.freeze({ ...portTable });
		this.ports = Object.freeze({
			relay: implementations.relay,
			clock: implementations.clock,
			pin: implementations.pin.bindState(this.state),
			amend: implementations.amend.bindState(this.state),
			herd: implementations.herd.bindState(this.state),
		});
	}

	/**
	 * Bind the fork ports once. Wiring supplies the registry, ledger and
	 * identity; the station derives ownership, depth and persistence from those
	 * plain inputs. A second attach cannot leave a duplicate owner field.
	 */
	bindForkPorts({
		registry = null,
		ledger = null,
		identity = null,
		childOutcomePort = null,
		setChildOutcome = null,
	} = {}) {
		if (ledger) {
			this.brackets = ledger;
			if (this.state) this.state.brackets = ledger;
		}
		this.forkLedgerPort = () => ledger;
		this.forkWaitPort = () => ({ registry, ledger });
		this.forkIdentityPort = () => identity;
		this.forkOwnerId = () =>
			typeof identity?.forkId === "string" && identity.forkId !== ""
				? identity.forkId
				: null;
		this.forkDepthPort = () =>
			Number.isInteger(identity?.childDepth)
				? identity.childDepth
				: this.forkOwnerId()
					? 1
					: 0;
		this.childOutcomePort = childOutcomePort;
		this.setChildOutcome = setChildOutcome;
		if (typeof identity?.persistRoot === "function") {
			this.persistLedger = identity.persistRoot;
		} else if (!identity) {
			this.persistLedger = () => this.persist?.();
		}
		return { registry, ledger, identity };
	}

	// -- Usage ledger ---------------------------------------------------------

	// The measured usage facts live in ../scope/usage-ledger.mjs. Siblings read
	// the ledger's public fields through `station.usage`; there is no forwarding
	// property layer, because a getter per field hides nothing.

	onUsageMessage(message, ctx) {
		this.finishRequestSample(Date.now(), message);
		this.usage.onMessage(message, ctx);
	}

	/**
	 * One LLM request completed. An open window is the request; usage is not
	 * required. A non-assistant message, or a second delivery of an assistant
	 * message already counted, leaves the window alone.
	 */
	finishRequestSample(now = Date.now(), message = null) {
		if (message?.role !== "assistant") return null;
		if (this.countedRequests?.has(message)) return null;
		const totals = this.brackets?.totals;
		if (!totals) return null;
		const delta = finishRequest(this.turnClock, totals, now);
		if (delta == null) return null;
		// `finishRequest` adds to `ledger.totals` in place. The shared snapshot
		// reuses the previous ledger copy, so a moved total must be announced or
		// the next persisted snapshot would keep the old number.
		markLedgerStructDirty(this.brackets);
		const key = modelKeyOf(message);
		if (key !== "") {
			this.turnModelKey = key;
			recordTurnSample(this.brackets, key, delta);
		}
		this.countedRequests?.add(message);
		return delta;
	}

	beginRequestSample(now = Date.now()) {
		return beginRequest(this.turnClock, now);
	}

	abandonRequestSample() {
		return abandonRequest(this.turnClock);
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
		const record = this.host?.report?.record ?? this.host?.record;
		record?.(domain, error, detail);
	}
	/**
	 * Record a scoped model switch the host refused. The ticket reports the
	 * outcome; the station owns the failure field and the diagnostics ring.
	 */
	noteScopedModelFailure(req, outcome) {
		const command = req?.command || "/switch";
		const reason = outcome?.reason ?? "host reported model switch failure";
		this.noteError("model", new Error(`${command}: ${reason}`));
	}

	/**
	 * Detach a fire-and-forget ticket from this sync beat. A rejection is a
	 * station failure, not an unhandled promise: record it and keep the turn
	 * alive. A synchronous throw from the capability takes the same path.
	 */
	dispatchFireAndForget(domain, start) {
		try {
			const result = start();
			if (result && typeof result.catch === "function") {
				result.catch((error) => this.noteError(domain, error));
			}
			return result;
		} catch (error) {
			this.noteError(domain, error);
			return undefined;
		}
	}

	// -- Policy --------------------------------------------------------------

	/**
	 * The only host-shaped value a station reads. `ctx` stays opaque: every
	 * field comes from the injected host bag, so a hostless station reads an
	 * empty branch and no agent instead of reaching into a host object.
	 */
	sessionView(ctx) {
		return {
			branch: () => this.host?.session?.branch?.(ctx) ?? [],
			agent: this.host?.session?.agent?.(ctx) ?? null,
		};
	}

	policy(ctx) {
		// A fork scope is a writable subagent by construction: it owns a budget
		// and a bracket. The host may classify the spawned session as a plain
		// main identity (a branch has no `session_init`, and its extension
		// context can still say `kind: "main"`), so the bound fork identity is
		// the authoritative marker. Without this check a child is treated as
		// read-only and every station transition stops.
		if (typeof this.forkOwnerId === "function" && this.forkOwnerId() !== null) {
			return READ_WRITE_SUBAGENT;
		}
		if (this.agentPolicy !== null) return this.agentPolicy;
		const view = this.sessionView(ctx);
		const policy = agentPolicy(view);
		// Freeze only a verdict backed by the host's persisted contract. The
		// runtime identity fallback carries no tool grant, so it must be
		// recomputed until `session_init` lands.
		if (policy === MAIN_AGENT) {
			if (view.agent?.kind === "main") this.agentPolicy = policy;
			return policy;
		}
		if (hasSessionInit(view)) {
			this.agentPolicy = policy;
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
			active = this.host?.session?.activeTools?.() ?? [];
		} catch {
			active = [];
		}
		if (!Array.isArray(active) || active.includes("todo")) return;
		// A host that filters `todo` out of every setActiveTools call returns
		// the same tool set each time. Retry only when that set changes.
		const key = active.join("\u0000");
		if (key === this.todoGrantKey) return;
		this.todoGrantKey = key;
		this.dispatchFireAndForget("tickets", () =>
			this.tickets.activateTools(active, undefined, false));
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
			const active = this.host?.session?.activeTools?.();
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
	relayPort() {
		return this.ports.relay;
	}

	relayOn(ctx) {
		// No ledger owed means no relay nudge and no todo override for any
		// agent tier. The policy object owns that decision, not a name string.
		if (!this.relayPort().owesLedger()) {
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
		this.dispatchFireAndForget("tickets", () => this.tickets.steer(text));
		return true;
	}

	/** Send one plain user message; the host starts a turn for it. */
	deliverUserMessage(text) {
		if (!text || !this.tickets.canPrompt) return false;
		this.dispatchFireAndForget("tickets", () => this.tickets.prompt(text));
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
		return this.toolCallLedger.messageForToolCall(toolCallId) ??
			this.assistantForToolCall(toolCallId)?.message;
	}

	prepareToolDispatch(message, id, name) {
		this.toolCallLedger.prepare(message, id, name);
		// Waiting on the other bracket is not this branch's work. A join or a
		// return may block for as long as the counterpart needs, so it never
		// carries the branch clock's limit.
		if (name === "scope_join" || name === "scope_return") return false;
		// A bounded clock keeps the gate open so the debt can be recorded; the
		// deadline itself is never handed to a host as a call limit.
		return this.clockPort().info(this.branchRecord())?.bounded === true;
	}

	toolGateVerdict(toolCallId) {
		return this.toolCallLedger.toolGateVerdict(toolCallId);
	}

	rememberToolGate(toolCallId, verdict) {
		this.toolCallLedger.rememberToolGate(toolCallId, verdict);
	}

	admitToolDispatch(id, name, ctx, receipt = null) {
		if (receipt) {
			// A receipt is the post-execution half of a guarded call, so it
			// normally follows an admission and this cache check is a hit. If
			// the bounded gate cache evicted the id, or a host uses only this
			// seam, admit now instead of letting a result skip the branch's
			// budget. Charging is idempotent through `state.charges`.
			//
			// A call that ends past the deadline keeps its result: the overrun
			// is a debt in the same count as a spent turn, never a kill.
			const record = this.branchRecord();
			if (record && this.clockPort().info(record)?.overtime) {
				notePanhandled(record, name, { callId: id });
			}
			if (!this.toolGateVerdict(id).hit) {
				const verdict = this.admitToolDispatch(id, name, ctx);
				if (verdict?.block) return verdict;
			}
			return undefined;
		}
		// Two seams admit one tool call: the host's `tool_call` hook and this
		// dispatch seam. `onToolCall` caches its verdict by tool-call id, so
		// whichever seam runs second is a cache read and never a second charge.
		// Reconstruct the arguments from the carrying message so a free skill
		// read or a staged-preview resolution is not charged as ordinary work.
		const carrying = this.messageForToolCall(id);
		const call = toolCalls(carrying).find((candidate) => candidate.id === id);
		let input = call?.arguments ?? {};
		if (typeof input === "string") {
			try {
				input = JSON.parse(input);
			} catch {
				input = {};
			}
		}
		const verdict = onToolCall(
			this,
			{ toolCallId: id, toolName: name, input },
			ctx,
		);
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

	/** The injected clock implementation; `on` is the port's default. */
	clockPort() {
		return this.ports.clock;
	}

	/**
	 * Freeze this branch's clock while it waits on another bracket. The root
	 * owns no record, so it has nothing to pause.
	 */
	pauseBranchClock() {
		return this.clockPort().pause(this.branchRecord());
	}

	/** Resume the clock and give back exactly the paused span. */
	resumeBranchClock() {
		return this.clockPort().resume(this.branchRecord());
	}

	/** The deadline is measured, never handed to a host as a call limit. */
	toolTimeLimit() {
		return this.clockPort().toolLimit(this.branchRecord());
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

	processAssistantMessage(message) {
		const controls = controlsIn(message);
		if (controls.length === 0) return;
		const key = processedKey(controls);
		if (this.toolCallLedger.hasMessage(key)) return;

		const existing = this.contextMessages();
		const firstIndex = findToolCallIndex(existing, controls[0].id);
		const currentPersisted = firstIndex >= 0;
		const base = currentPersisted ? existing : [...existing, message];
		const currentIndex = currentPersisted ? firstIndex : base.length - 1;
		let changed = false;
		for (const call of controls) {
			const amendArgs = amendArgumentsOf(call);
			if (amendArgs === null) continue;
			if (this.toolCallLedger.hasCall(call.id)) continue;
			const boundary = this.amendBoundary(currentIndex, message);
			const result = handleAmendCall(
				this,
				{ id: call.id, name: "amend", arguments: amendArgs },
				base,
				currentIndex,
				boundary,
			);
			this.toolCallLedger.setHandled(call.id, result);
			// Mark after the work succeeded. A throw must leave both the call
			// and the message unmarked, so the scan path can retry it; the
			// tool path stays idempotent because a completed call is marked.
			this.toolCallLedger.markCall(call.id);
			changed = true;
		}

		this.toolCallLedger.markMessage(key);
		if (changed) this.persist();
	}

	processControlsForTool(toolCallId) {
		const found = this.assistantForToolCall(toolCallId);
		if (!found) return;
		this.processAssistantMessage(found.message);
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
	finalizeJoin(toolCallId, record, ctx) {
		const persisted = confirmJoinPersistence(this);
		if (persisted === false) {
			this.noteError?.("fork", new Error("join receipt was not persisted"), {
				forkId: record.forkId,
				phase: "join",
			});
		}
		const result = renderJoinResult(this, record, {
			closeToolCallId: toolCallId,
			persisted,
		});
		const processed = processedOf(this);
		processed?.setHandled?.(toolCallId, result);
		processed?.markCall?.(toolCallId);
		this.persist();
		return result;
	}

	executeSend(toolCallId, params, ctx) {
		return executeSend(this, toolCallId, params, ctx);
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

	// The three session ports are bound to this station's persisted state in
	// the constructor. One object per station; no per-call factory.
	pinPort() {
		return this.ports.pin;
	}

	amendPort() {
		return this.ports.amend;
	}

	herdPort() {
		return this.ports.herd;
	}

	directAmend(toolCallId, params) {
		return directAmend(this, toolCallId, params);
	}

	executeContext(toolCallId, params) {
		return executeContext(this, toolCallId, params);
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

	// -- Nudge -----------------------------------------------------------------

	maybeNudge(message, ctx) {
		if (!message || message.role !== "assistant") return;
		if (message.stopReason === "aborted" || message.stopReason === "error") return;
		// Keep the observable relay verdict current, but never let it veto the
		// join nudge: an unreceived bracket is liveness, not relay policy.
		this.relayOn(ctx);
		if (this.nudged.has(message)) return;
		const ledger =
			typeof this.forkLedgerPort === "function" ? this.forkLedgerPort() : null;
		const ownerId =
			typeof this.forkOwnerId === "function" ? this.forkOwnerId() : null;
		const decision = nudgeDecision({
			hasToolCalls: toolCalls(message).length > 0,
			ledger,
			ownerId,
		});
		if (decision.kind === "none") return;
		// A steer the host refuses was never delivered, so it must not spend the
		// child's allowance and must not mark the message as served.
		if (!this.deliverSteer(decision.text)) return;
		this.nudged.add(message);
		if (decision.charge === "return" && ledger && ownerId !== null) {
			takeReturnNudge(forkOf(ledger, ownerId));
		}
	}

	// -- Rebase -----------------------------------------------------------------

	maybeRebase(ctx, outbound) {
		if (!this.anchor.needsRebase()) return;
		const tree = this.contextMessages();
		if (!shouldRebase({ needsRebase: true, tree, outbound })) return;
		if (this.host?.session?.setMessages?.(ctx, tree)) this.anchor.clearRebase();
	}

	// -- Context transform (sync) -----------------------------------------------

	transformContext(original, ctx, firstTurn = null) {
		try {
			const model = actualModel(ctx, this.host);
			const key = modelKey(model);
			const needsRebase = this.anchor.needsRebase();
			const tree = needsRebase ? this.contextMessages() : null;
			const projection = projectContext(
				{ amends: this.state.amends },
				{
					original,
					tree,
					needsRebase,
					ports: this.portTable,
					modelKey: key,
					header: key ? (this.host?.session?.header?.(ctx) ?? null) : null,
					firstTurn,
				},
			);
			// Commit: the projection is complete. Write the host rebase and the
			// usage snapshot. No ticket dispatch follows, so no ticket can
			// observe a half-written state.
			if (projection.rebase && tree && this.host?.session?.setMessages?.(ctx, tree)) {
				this.anchor.clearRebase();
			}
			if (projection.usage) this.usage.noteSentContext(projection.usage);
			return { messages: projection.messages };
		} catch (error) {
			this.noteError("context", error);
			if (error?.code === "FOLD_ROLLBACK_FAILED") {
				// The host catches context-handler errors. Cancel the live Agent
				// too, so a broken journal cannot reach the provider unchanged.
				this.host?.session?.abort?.(ctx, error);
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

	/** A natural stop is a small handoff: it transfers the holder, not the count. */
	recordNaturalStop(ctx) {
		return recordNaturalStop(this, ctx);
	}

	/** The successor has looked at the inherited ledger; the requirement ends. */
	markInheritedLedgerViewed() {
		return markInheritedLedgerViewed(this);
	}

	/**
	 * Relay bookkeeping: this station is the pending handoff target.
	 *
	 * The registry is the station's composition bridge, so its relay
	 * bookkeeping is reached here instead of from the pure handoff module.
	 * A station double may pass a registry without these methods.
	 */
	markPending() {
		this.registry?.markPending?.(this);
	}

	/** Relay bookkeeping: no successor is pending any more. */
	clearPending() {
		this.registry?.clearPending?.(this);
	}

	// -- Gatekeepers (sync event entries) ---------------------------------------

	onAutopilotCommand(args) {
		return onAutopilotCommand(this, args);
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
			ownerId !== null,
			this.clockPort(),
			this.portTable.chineseReminder,
		);
		return {
			role: "user",
			content: [{ type: "text", text }],
			attribution: "agent",
			timestamp: Date.now(),
			autopilot: this.state.autopilot === true,
			branch: ownerId !== null,
			herdSkill: true,
		};
	}

	prepareRequest(ctx, previous, history) {
		return prepareRequest(this, ctx, previous, history);
	}

	onContext(messages, ctx, firstTurn = null) {
		return onContext(this, messages, ctx, firstTurn);
	}

	onSessionStop(ctx, evidence = null) {
		this.abandonRequestSample();
		return onSessionStop(this, ctx, evidence);
	}

	/**
	 * End every descendant this level still owes a receive. Called by the
	 * session-stop gate when the user aborts the turn, and safe to call again:
	 * a second pass finds no open descendant and changes nothing.
	 */
	cancelDescendants() {
		return cancelDescendants(this);
	}

	onSessionSwitch(event, ctx) {
		return onSessionSwitch(this, event, ctx);
	}

	onSessionCompact(ctx) {
		return onSessionCompact(this, ctx);
	}

	onBeforeAgentStart(event, ctx) {
		// A failed request leaves its window open. The next agent turn starts
		// here, before before_provider_request, so dropping it cannot erase a
		// request that already finished (startedAt is already null).
		this.abandonRequestSample();
		return onBeforeAgentStart(this, event, ctx);
	}
}

