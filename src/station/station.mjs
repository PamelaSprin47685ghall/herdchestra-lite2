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

  import { roleOfPath } from "../scope/roles.mjs";
  import {
  	chargeBranch,
	createBracketLedger,
	abandonRequest,
	beginRequest,
	createTurnClock,
	createUsageLedger,
	diffDirectory,
	finishRequest,
	isFreeCall,
	markLedgerStructDirty,
	planLedgerEntry,
	planStateEntry,
	projectDirectory,
	serializeState,
	serializeStateCore,
	splitState,
	forkOf,
	unreceivedChildren,
	updateRecordSnapshot,
	updateRootMeta,
} from "../scope/index.mjs";
import { takeReturnNudge } from "../scope/return-nudge.mjs";
import { recordTurnSample } from "../scope/turn-stats.mjs";
import {
	adoptLedger,
	conversationKeyOf,
	ledgerFor,
} from "../scope/fork-registry.mjs";

import {
	findToolCallIndex,
	toolCalls,
} from "../transcript/index.mjs";
import {
	agentPolicy,
	hasSessionInit,
	MAIN_AGENT,
	READ_WRITE_SUBAGENT,
} from "../core/policy.mjs";
import { PORT_NAMES } from "../core/ports/registry.mjs";
import { mergeFeatures } from "../features/herd/features.mjs";
import { IMPLEMENTATION_KEYS, missingPortsError } from "./ports-contract.mjs";
import {
	forkRemaining,
	projectCapabilities,
	renderConsoleReceipt,
} from "./domain/capabilities.mjs";
import { closedLeafId } from "./domain/snapshot-leaf.mjs";
import {
	executeAbandon,
	executeFork,
	executeJoin,
	executeReturn,
} from "./execute.mjs";
import {
	confirmJoinPersistence,
	renderJoinResult,
} from "./fork-controls.mjs";
import {
	clearPendingRootRewind,
	commitRootRewind,
	finishRewind,
	syncRootUserPrompts,
} from "./handoff-state.mjs";
import {
	cancelDescendants,
	cancelTree,
	onAgentEnd,
	onAssistantMessage,
	onBeforeAgentStart,
	onContext,
	onHerdCommand,
	onGoalCommand,
	onMessageEnd,
	onSessionCompact,
	onSessionStop,
	onSessionSwitch,
	prepareRequest,
} from "./gates.mjs";
import {
	projectContext,
	shouldRebase,
	resolveContextWindow,
} from "./domain/context.mjs";
import { selectForkLedger } from "./domain/fork-ledger.mjs";
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
import { createPersistenceAnchor } from "./persistence-anchor.mjs";
import { nudgeDecision } from "./nudge.mjs";

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
			header: pick(session.header, source.contextHeaderOf),
			setMessages: pick(session.setMessages, source.setAgentMessages),
			appendHistory: pick(session.appendHistory, source.appendHistoryMessage),
			settingsOf: pick(session.settingsOf, source.settingsOf),
			// A grouped host owns the abort verb. The legacy flat bag kept a
			// `sessionFor` lookup instead; keep that as the fallback so both
			// shapes reach the same agent. Dropping the grouped form turned
			// every root interrupt into a silent no-op.
			abort:
				typeof session.abort === "function"
					? (ctx, error) => session.abort(ctx, error)
					: (ctx, error) => source.sessionFor?.(ctx)?.agent?.abort?.(error),
			canRewindRoot: pick(session.canRewindRoot, source.canRewindRoot),
		},
		model: {
			of: pick(model.of, source.modelOf),
			thinkingOf: pick(model.thinkingOf, source.thinkingOf),
			parseSpec: pick(model.parseSpec, source.preparseModelSpec),
			capabilities: pick(model.capabilities, source.capabilities),
			query: pick(model.query, source.models),
		},
		// The confiscated tools. A host that predates this seam leaves both
		// undefined, and the js runtime then binds only the control plane.
		tools: {
			listSpecs: pick(source.tools?.listSpecs, source.listToolSpecs),
			execute: pick(source.tools?.execute, source.executeTool),
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
			sameManager: pick(fork.sameManager, source.sameManager),
			ledgerFor: pick(fork.ledgerFor, source.ledgerFor),
			adoptLedger: pick(fork.adoptLedger, source.adoptLedger),
		},
		report: { record: pick(report.record, source.record) },
	};
}

export class SessionStation {
	constructor(manager, host, tickets, stationRegistry, pricingCatalog) {
		this.manager = manager;
		this.host = shapeHost(mergeHost(stationRegistry?.host?.(), host));
		this.tickets = tickets;
		this.pricingCatalog =
			pricingCatalog ?? this.host?.accounting?.pricing?.emptyCatalog?.() ?? null;
		this.state = restoreState(manager, this.host?.report?.record);
		const featureConfig =
			typeof stationRegistry?.features === "function"
				? stationRegistry.features()
				: null;
		if (featureConfig) {
			this.state.features = mergeFeatures(this.state.features, featureConfig.explicit);
		}
		// A replayable base on disk anchors a delta; a fresh session, or a
		// chain whose anchor fell outside the replay window, starts with a
		// checkpoint instead.
		const hasBase = hasPersistedBase(manager);
		const baseId = hasBase ? persistedBaseId(manager) : null;
		// Both halves of one serialization: the core anchors a state delta and
		// the ledger half seeds the ledger snapshot, so the first write after a
		// load subtracts from what the journal already holds instead of
		// restating it. `serializeState` copies rather than sharing, which is
		// what makes the seed safe against a record edited in place.
		const base = baseId === null ? null : splitState(serializeState(this.state));
		this.anchor = createPersistenceAnchor({
			manager,
			state: () => this.state,
			initialState: base ? base.core : null,
			initialLedger: base ? base.brackets : null,
			initialEntryId: baseId,
			serialize: serializeStateCore,
			plan: planStateEntry,
			planLedger: planLedgerEntry,
			split: splitState,
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
		// One boundary scan per projected array: see `cachedHostBoundaryKey`.
		this.hostBoundaryScan = null;
		// One projection per branch leaf: see `contextMessages`.
		this.contextCache = null;
		this.agentPolicy = null;
		this.pendingChildRewind = null;
		this.childRewindAvailable = true;
		this.rewoundThisTurn = false;
		this.rewindDispatching = null;
		this.pendingModelSwitch = null;
		this.modelSwitchInFlight = null;
		// The bracket ledger is session-wide: parent and child live in
		// different agents and must see the same pairing. The scope state owns
		// the tree so a reload restores it, while the registry indexes the live
		// object: a running tree wins, a restored non-empty tree wins over an
		// empty index, and two fresh stations of one conversation share one
		// empty ledger instead of growing two.
		const forkWiring = stationRegistry?.forkWiring?.() ?? null;
		this.forkWiring = forkWiring;
		const key = (this.host?.session?.conversationKey ?? conversationKeyOf)(manager ?? null);
		const indexed =
			forkWiring && key !== null
				? ((this.host?.fork?.ledgerFor ?? ledgerFor)(forkWiring.registry, key) ?? null)
				: null;
		const restored = this.state.brackets ?? null;
		// The tree choice and the totals fill live in the domain helper; passing
		// `create` states that a fresh session needs an empty ledger minted.
		const { ledger: chosen, adopt } = selectForkLedger({
			indexed,
			restored,
			create: createBracketLedger,
		});
		this.brackets = chosen;
		if (forkWiring && key !== null && adopt) {
			(this.host?.fork?.adoptLedger ?? adoptLedger)(forkWiring.registry, key, this.brackets);
		}
		this.state.brackets = this.brackets;
		// Attached by the host wiring; null means this station cannot wait.
		this.forkWaitPort = null;
		// Fork ports the host wiring overrides. Each default answers a plain
		// value, so a reader calls the port without a `typeof` probe: attaching
		// replaces the default. `forkDepthPort` reports the root depth until a
		// child identity supplies its own. `setChildOutcome` is the exception,
		// kept null: root has no parent to hand a record to, and a return there
		// must not render one.
		this.forkLedgerPort = () => null;
		this.forkOwnerId = () => null;
		this.forkIdentityPort = () => null;
		this.forkDepthPort = () => 0;
		this.forkWindowPort = () => null;
		this.forkReservePort = () => undefined;
		this.forkMarginPort = () => undefined;
		this.childOutcomePort = () => null;
		this.setChildOutcome = null;
		this.abortChildrenPort = () => 0;
		this.interruptScopePort = () => false;
		this.persistLedger = () => this.persist?.();
		this.forkReports = new Map();
		this.selfForkId = null;
		this.lastSeenDir = new Map();
		this.pendingDirSeen = null;
		this.lastDirSeq = -1;
		this.lastPendingDirSeq = -1;
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
			window: () => this.contextWindowTokens(),
		});
		this.usage.restoreFromBranch(this.manager);
		// The composition root builds one complete bundle; bind each
		// implementation to this station's persisted state exactly once. A
		// station without a complete bundle cannot start: a fallback here
		// would be a second composition root and would hide the missing
		// capability until the port was first used.
		const implementations = stationRegistry?.implementations?.();
		const missing = IMPLEMENTATION_KEYS.filter(
			(key) => !implementations?.[key],
		);
		if (missing.length > 0) throw missingPortsError(missing);
		const portTable = stationRegistry?.ports?.();
		const missingNames = PORT_NAMES.filter(
			(name) => typeof portTable?.[name] !== "string",
		);
		if (missingNames.length > 0) throw missingPortsError(missingNames);
		this.portTable = Object.isFrozen(portTable)
			? portTable
			: Object.freeze({ ...portTable });
		this.ports = Object.freeze({
			clock: implementations.clock,
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
		// A null port is an absent capability, not a missing default. The
		// outcome reader answers null; the sink stays null because a station
		// without one has nobody to hand a rendered record to.
		this.childOutcomePort =
			typeof childOutcomePort === "function" ? childOutcomePort : () => null;
		this.setChildOutcome =
			typeof setChildOutcome === "function" ? setChildOutcome : null;
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
		this.noteDirectoryUsage(message);
		if (
			message?.role === "assistant" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			this.pendingDirSeen instanceof Map
		) {
			this.lastSeenDir = this.pendingDirSeen;
			this.pendingDirSeen = null;
			this.lastDirSeq = this.lastPendingDirSeq;
		}
	}

	measuredOccupancy() {
		const input = this.usage?.lastTotalInput;
		const output = this.usage?.lastOutputTokens;
		if (!Number.isFinite(input)) return null;
		return input + (Number.isFinite(output) ? output : 0);
	}

	noteDirectoryModel(ctx, live) {
		const ledger = this.forkLedgerPort();
		if (!ledger) return;
		const key = modelKey(live);
		const thinkingLevel = this.host?.model?.thinkingOf?.(ctx) ?? null;
		const window = this.contextWindowTokens();
		const ownerId = this.forkOwnerId();
		if (ownerId === null) {
			updateRootMeta(ledger, {
				...(key ? { model: key } : {}),
				thinkingLevel,
				...(Number.isFinite(window) && window > 0 ? { contextWindow: window } : {}),
			});
		} else {
			updateRecordSnapshot(ledger, ownerId, {
				...(key ? { resolvedModel: key } : {}),
				resolvedThinking: thinkingLevel,
				...(Number.isFinite(window) && window > 0 ? { contextWindow: window } : {}),
			});
		}
	}

	noteDirectoryUsage(_message) {
		const ledger = this.forkLedgerPort();
		if (!ledger) return;
		const occupancy = this.measuredOccupancy();
		if (!Number.isFinite(occupancy)) return;
		const ownerId = this.forkOwnerId();
		if (ownerId === null) {
			const baseline = this.usage?.baselineTokens;
			updateRootMeta(ledger, {
				contextTokens: occupancy,
				...(ledger.root?.dirContextTokens == null && Number.isFinite(baseline)
					? { dirContextTokens: baseline }
					: {}),
			});
		} else {
			updateRecordSnapshot(ledger, ownerId, {
				snapshotContextTokens: occupancy,
			});
		}
	}

	noteSnapshotLeaf(_ctx) {
		const ledger = this.forkLedgerPort();
		if (!ledger) return;
		let leafId = null;
		const branch = this.manager?.getBranch?.();
		if (Array.isArray(branch)) {
			leafId = closedLeafId(branch);
		} else if (typeof this.manager?.getLeafId === "function") {
			leafId = this.manager.getLeafId() ?? null;
		}
		this.noteSnapshotMeta(leafId, this.measuredOccupancy());
	}

	noteSnapshotMeta(leafId, occupancy = null) {
		const ledger = this.forkLedgerPort();
		if (!ledger) return;
		const ownerId = this.forkOwnerId();
		if (ownerId === null) {
			updateRootMeta(ledger, {
				...(typeof leafId === "string" && leafId !== "" ? { safeSnapshotLeafId: leafId } : {}),
				...(Number.isFinite(occupancy) ? { contextTokens: occupancy } : {}),
			});
		} else {
			updateRecordSnapshot(ledger, ownerId, {
				...(typeof leafId === "string" && leafId !== "" ? { safeSnapshotLeafId: leafId } : {}),
				...(Number.isFinite(occupancy) ? { snapshotContextTokens: occupancy } : {}),
			});
		}
	}

	resetDirectoryBaseline() {
		this.lastSeenDir = new Map();
		this.pendingDirSeen = null;
		this.lastDirSeq = -1;
		this.lastPendingDirSeq = -1;
		if (this.forkOwnerId() === null) {
			const ledger = this.forkLedgerPort();
			if (ledger) updateRootMeta(ledger, { dirContextTokens: null });
		}
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
		if (this.forkOwnerId() !== null) {
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

	/**
	 * The live context messages, rebuilt by the host only when the branch
	 * actually moved.
	 *
	 * `buildSessionContext()` walks the whole branch and projects every entry,
	 * so a station that calls it on each assistant message, tool call and model
	 * request pays Θ(entries) several times per turn and Θ(entries²) per
	 * session. The leaf id is the branch's identity: every append, amend and
	 * branch switch produces a new leaf, so an unchanged leaf id means the same
	 * projection. Without a leaf id the cache is never used and every call
	 * rebuilds, which is the old behavior rather than a guess.
	 */
	contextMessages() {
		try {
			const manager = this.manager;
			const leafId =
				typeof manager?.getLeafId === "function" ? manager.getLeafId() : null;
			const cache = this.contextCache;
			if (leafId !== null && leafId !== undefined && cache && cache.leafId === leafId) {
				return cache.messages;
			}
			const context = manager?.buildSessionContext?.();
			const messages = Array.isArray(context?.messages) ? context.messages : [];
			this.contextCache =
				leafId !== null && leafId !== undefined ? { leafId, messages } : null;
			return messages;
		} catch {
			this.contextCache = null;
			return [];
		}
	}

	assistantForToolCall(toolCallId) {
		const messages = this.contextMessages();
		const index = findToolCallIndex(messages, toolCallId);
		if (index < 0) return null;
		return { messages, index, message: messages[index] };
	}

	/** The assistant message that carries this tool call. */
	messageForToolCall(toolCallId) {
		return this.assistantForToolCall(toolCallId)?.message ?? null;
	}

	/** The fork record of this branch, or null at the root. */
	branchRecord() {
		const ledger = this.forkLedgerPort();
		const ownerId = this.forkOwnerId();
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

	/**
	 * The live model's input limit, or null when no exact window is known.
	 *
	 * One owner for the window. The nudge arithmetic, the join admission and
	 * the receipt projection all read this method instead of each resolving
	 * the catalog in its own order.
	 */
	contextWindowTokens() {
		return resolveContextWindow(this);
	}

	/** True when the next request must carry the return nudge. */
	contextNudgeArmed() {
		return this.usage?.contextNudge === true;
	}

	/** Live outbound watermark from the last usage plus fresh pending messages. */
	currentContextTokens(messages, key) {
		return this.usage.currentContextTokens(messages, key);
	}

	/** True when a message already carries the usage that closes a scope. */
	usageArrivedFor(message) {
		return this.usage.usageArrivedFor(message);
	}

	resetUsageWatermark() {
		this.usage.resetWatermark();
	}

	// -- js capability projection (sync) ---------------------------------------

	directoryDelta(ledger) {
		if (!ledger || typeof ledger !== "object") {
			const rootOnly = projectDirectory(null);
			const scopesDelta = diffDirectory(this.lastSeenDir, rootOnly);
			return { scopesDelta, currentDir: rootOnly, dirSeq: 0 };
		}
		const dirSeq = Number.isInteger(ledger.dirSeq) ? ledger.dirSeq : 0;
		if (
			this.lastDirSeq === dirSeq &&
			this.lastSeenDir.size > 0 &&
			this.pendingDirSeen === null
		) {
			return { scopesDelta: null, currentDir: this.lastSeenDir, dirSeq };
		}
		const currentDir = projectDirectory(ledger);
		const scopesDelta = diffDirectory(this.lastSeenDir, currentDir);
		return { scopesDelta, currentDir, dirSeq };
	}

	/**
	 * The raw point-in-time facts a projection needs. One gatherer for the
	 * probe, the cache signature and the vm binding, so the three cannot drift.
	 */
	capabilitySnapshot(ctx) {
		const ledger = this.forkLedgerPort();
		const ownerId = this.forkOwnerId();
		const record = this.branchRecord();
		const isChild = ownerId !== null;
		const selfPath = record?.path ?? (isChild ? `/${ownerId}` : "/");
		const abandoned =
			isChild && record?.abandonRequested === true
				? {
						by: record.abandonedBy ?? "/",
						...(record.abandonReason ? { reason: record.abandonReason } : {}),
					}
				: null;
		const { scopesDelta, currentDir, dirSeq } = this.directoryDelta(ledger);
		const specs = (() => {
			try {
				return typeof this.host?.tools?.listSpecs === "function"
					? this.host.tools.listSpecs(ctx) ?? []
					: [];
			} catch {
				return [];
			}
		})();
		const hostToolNames = [];
		for (const spec of Array.isArray(specs) ? specs : []) {
			if (typeof spec?.name === "string" && spec.name !== "") hostToolNames.push(spec.name);
		}
		let clock = null;
		try {
			clock = typeof this.clockPort === "function" ? (this.clockPort() ?? null) : null;
		} catch {
			clock = null;
		}
		return {
			isChild,
			autopilot: this.state?.relay?.goal === true,
			chinese: this.state?.features?.chinese ?? "on",
			unreceived: ledger ? unreceivedChildren(ledger, ownerId ?? "root").length : 0,
			canStop: this.state?.relay?.canStop === true,
			contextOverHalf: this.contextNudgeArmed(),
			abandoned,
			remaining: clock ? forkRemaining(record, Date.now(), clock) : null,
  		selfPath,
  		role: selfPath === "/" ? "manager" : (record?.role ?? roleOfPath(selfPath)),
  		scopesDelta,
			_currentDir: currentDir,
			_dirSeq: dirSeq,
			hostToolNames,
		};
	}

	/**
	 * The path this scope answers to. Root is `/`; a subscope reads its own fork
	 * record first.
	 */
	selfScopePath() {
		const ownerId = this.forkOwnerId();
		if (ownerId === null || ownerId === undefined) return "/";
		const path = this.branchRecord()?.path;
		if (typeof path === "string" && path !== "") return path;
		return `/${ownerId}`;
	}

	/**
	 * The shared ForkRegistry for the whole fork tree, or null when no fork
	 * wiring or wait port is attached. Never falls back to StationRegistry.
	 */
	forkRegistry() {
		return this.forkWaitPort?.()?.registry ?? this.forkWiring?.registry ?? null;
	}

	/** The frozen projection for this beat. */
	projectionFor(ctx) {
		const snapshot = this.capabilitySnapshot(ctx);
		const projection = projectCapabilities(snapshot);
		this._lastDirMeta = { currentDir: snapshot._currentDir, dirSeq: snapshot._dirSeq };
		return projection;
	}

	/** The cache signature only; no side effects. */
	capSignature(ctx) {
		return this.projectionFor(ctx).signature;
	}

	/**
	 * Pre-check of one js beat: the frozen projection the ticket binds into the
	 * vm. Returns `{ mode, tools, state, signature }`; the ticket reads `tools`
	 * and `state`.
	 */
	beginJsCall(ctx) {
		return this.projectionFor(ctx);
	}

	/**
	 * Reconcile of one js beat: settle the beat's accounting in one atomic
	 * step. Every inner call is charged through the same branch budget the
	 * native tools used; the outer tool-call id groups the shares so a
	 * multi-call script is charged exactly as one parallel native batch was.
	 * Never throws: the ticket's outcome must not be replaced by an accounting
	 * failure.
	 */
	finishJsCall(toolCallId, calls, ctx) {
		try {
			const ledger =
				this.forkLedgerPort();
			const ownerId =
				this.forkOwnerId();
			if (ownerId === null || !ledger) return;
			const list = Array.isArray(calls) ? calls : [];
			const beatTools = list.map((call) => ({
				name: call.name,
				free: isFreeCall(call.name, call.args),
			}));
			let changed = false;
			for (const call of list) {
				const charged = chargeBranch(this.state, ledger, {
					ownerId,
					toolCallId: call.id,
					toolName: call.name,
					groupKey: toolCallId,
					beatTools,
					input: call.args,
				});
				if (charged?.ok === false) {
					this.noteError?.(
						"accounting",
						new Error(charged.reason ?? charged.code ?? "charge refused"),
					);
					continue;
				}
				if (charged?.alreadyCharged !== true && charged?.amount !== 0) changed = true;
			}
			if (changed) this.persist();
		} catch (error) {
			this.noteError?.("accounting", error);
		}
	}

	// -- Execute cores (called by tickets) -------------------------------------

	executeFork(toolCallId, params, ctx, frameId) {
		return executeFork(this, toolCallId, params, ctx, frameId);
	}

	executeJoin(toolCallId, params, ctx, frameId) {
		return executeJoin(this, toolCallId, params, ctx, frameId);
	}

	/**
	 * Finish a join whose record was already taken by the waiting ticket.
	 * The station caches the result, so a later replay of the same call sees
	 * the same answer instead of looking for a child that is already closed.
	 */
	finalizeJoin(toolCallId, record, ctx, frameId) {
		const persisted = confirmJoinPersistence(this);
		if (persisted === false) {
			this.noteError?.("fork", new Error("join receipt was not persisted"), {
				forkId: record.forkId,
				phase: "join",
			});
		}
		const result = renderJoinResult(this, record, {
			closeToolCallId: frameId ?? toolCallId,
			persisted,
		});
		const processed = processedOf(this);
		processed?.setHandled?.(toolCallId, result);
		processed?.markCall?.(toolCallId);
		this.persist();
		return result;
	}

	executeReturn(toolCallId, params, ctx, frameId) {
		return executeReturn(this, toolCallId, params, ctx, frameId);
	}

	executeAbandon(toolCallId, params, ctx) {
		return executeAbandon(this, toolCallId, params, ctx);
	}

	// The scope port is bound to this station's persisted state in the
	// constructor. One object per station; no per-call factory.
	herdPort() {
		return this.ports.herd;
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
		if (this.nudged.has(message)) return;
		const ledger =
			this.forkLedgerPort();
		const ownerId =
			this.forkOwnerId();
		const projection = this.projectionFor(ctx);
		const decision = nudgeDecision({
			hasToolCalls: toolCalls(message).length > 0,
			ledger,
			ownerId,
			mode: projection.mode,
			unreceived: projection.state?.unreceived ?? 0,
			relay: this.state?.relay ?? null,
			abandoned: projection.state?.abandoned ?? null,
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

	transformContext(original, ctx) {
		try {
			const model = actualModel(ctx, this.host);
			const key = modelKey(model);
			const needsRebase = this.anchor.needsRebase();
			const tree = needsRebase ? this.contextMessages() : null;
			const projection = projectContext(
				{},
				{
					original,
					tree,
					needsRebase,
					ports: this.portTable,
					modelKey: key,
					header: key ? (this.host?.session?.header?.(ctx) ?? null) : null,
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

	commitRootRewind(ctx, plan = null) {
		const committed = commitRootRewind(this, ctx, plan);
		if (this.rewindDispatching === plan?.pending || committed) {
			this.rewindDispatching = null;
		}
		return committed;
	}

	abortRootRewind(plan = null) {
		return clearPendingRootRewind(this, plan);
	}

	finishRewind(options = {}) {
		return finishRewind(this, options);
	}

	syncRootUserPrompts(messages = null) {
		return syncRootUserPrompts(this, messages);
	}

	// -- Gatekeepers (sync event entries) ---------------------------------------

	onHerdCommand(args) {
		return onHerdCommand(this, args);
	}

	onGoalCommand(args) {
		return onGoalCommand(this, args);
	}

	/** Clear the one-shot goal flag after a sealed delivery. */
	endGoalSession() {
		if (this.state?.relay?.goal !== true) return false;
		this.state.relay.goal = false;
		this.persist();
		return true;
	}

	onAssistantMessage(message, ctx) {
		return onAssistantMessage(this, message, ctx);
	}

	onMessageEnd(event, ctx) {
		return onMessageEnd(this, event, ctx);
	}

	/**
	 * Build the per-turn REPL probe. It is level-triggered: the whole current
	 * projection is printed every turn, so a lost transition cannot hide the
	 * truth. On the one turn where keys disappear, edge lines print first.
	 *
	 * The receipt carries `capSig`, the exact signature the probe was rendered
	 * from; `receiptMatches` compares it instead of the retired mode booleans.
	 */
	skillReceipt(ctx) {
		const projection = this.projectionFor(ctx);
		const previous = Array.isArray(this.lastCapKeys) ? this.lastCapKeys : [];
		const removedKeys = previous.filter((key) => !projection.tools.includes(key));
		this.lastCapKeys = projection.tools.slice();
		// Record the in-flight directory snapshot; `lastSeenDir` only advances
		// once an assistant reply arrives, so retries keep identical deltas.
		this.pendingDirSeen = this._lastDirMeta?.currentDir ?? null;
		this.lastPendingDirSeq = this._lastDirMeta?.dirSeq ?? -1;
		const text = renderConsoleReceipt(projection, {
			removedKeys,
			chinese: this.state?.features?.chinese ?? "on",
		});
		const ownerId =
			this.forkOwnerId();
		return {
			role: "user",
			content: [{ type: "text", text }],
			attribution: "agent",
			timestamp: Date.now(),
			autopilot: this.state?.relay?.goal === true,
			branch: ownerId !== null,
			canStop: this.state.relay?.canStop === true,
			herdSkill: true,
			capSig: projection.signature,
		};
	}

	prepareRequest(ctx, previous, history) {
		return prepareRequest(this, ctx, previous, history);
	}

	onContext(messages, ctx) {
		return onContext(this, messages, ctx);
	}

	onSessionStop(ctx, evidence = null) {
		this.abandonRequestSample();
		return onSessionStop(this, ctx, evidence);
	}

	onAgentEnd(ctx, event = null) {
		return onAgentEnd(this, ctx, event);
	}

	/**
	 * The typed user-abort gate. Esc/Stop is a decision about the conversation
	 * branch, not about the station whose host observed it, so the cascade is
	 * anchored at the conversation ledger root regardless of depth.
	 */
	onUserAbort(ctx, evidence = null) {
		clearPendingRootRewind(this);
		return cancelTree(this, "root", evidence?.reason ?? undefined);
	}

	/**
	 * End every descendant this level still owes a receive. Internal cascade
	 * helper; safe to call again: a second pass finds no open descendant and
	 * changes nothing.
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

