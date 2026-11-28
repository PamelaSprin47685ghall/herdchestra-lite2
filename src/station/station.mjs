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
	finishRequest,
	isFreeCall,
	markLedgerStructDirty,
	planLedgerEntry,
	planStateEntry,
	truncateForHostBoundary,
	serializeState,
	serializeStateCore,
	splitState,
  	forkOf,
  	hasLegacyUnknownHostBoundary,
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
import { forkRemaining } from "./domain/capabilities.mjs";
import {
	clearContextCache as forgetContextCache,
	clearScan,
	contextForLeaf,
  	createHostBoundary,
  	observeHostBoundary,
  	syncHostBoundary,
  } from "./domain/host-boundary.mjs";
import {
	createDirectoryBaseline,
	directoryDelta as computeDirectoryDelta,
	resetBaseline,
	settleBaseline,
	stageScan,
} from "./domain/directory-baseline.mjs";
import {
	createProjectionState,
	project,
	renderReceipt,
	stageDirMeta,
} from "./domain/projection.mjs";
import { closedLeafId } from "./domain/snapshot-leaf.mjs";
import {
	executeAbandon,
	executeFork,
	executeJoin,
	executeReturn,
} from "./execute.mjs";
import { finalizeJoinRecord } from "./join-controls.mjs";
import { measuredOccupancy as occupancyOf } from "./domain/usage-sample.mjs";
import {
	childRewindPermitted,
	clearRootRewind,
	consumeChildRewind,
	createRewindState,
	disableChildRewind,
	hasPendingChildRewind,
	markRootDispatch,
	modelSwitchBusy,
	queueModelSwitch,
	rootDispatchBusy,
	settleModelSwitch,
	settleRootRewind,
	stageChildRewind,
	takeModelSwitch,
} from "./domain/rewind.mjs";
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
	createForkContext,
	createUnboundForkContext,
} from "./domain/fork-context.mjs";

// The bundle a station answers with before any wiring attached one, and the one
// a double that never ran the constructor answers with. Every capability is the
// value a missing capability must answer; it is never a second convention.
const UNBOUND = createUnboundForkContext();
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
import { mergeHost, shapeHost } from "../core/host-shape.mjs";

/**
 * Running scopes per role, read from the fork ledger. Root is one running
 * manager and has no fork record. Only the probe's idle-hands summary reads
 * this; it is not an admission gate.
 */
function runningCountsByRole(ledger) {
	const counts = { manager: 1, devops: 0, editor: 0, inspector: 0 };
	for (const forkId of Array.isArray(ledger?.order) ? ledger.order : []) {
		const record = forkOf(ledger, forkId);
		if (!record || record.status !== "running") continue;
		const role = record.role ?? roleOfPath(record.path);
		if (Object.hasOwn(counts, role)) counts[role] += 1;
	}
	return counts;
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
		// One boundary cache: the keyed scan and the per-leaf projection. The
		// kernel owns the fields; the station owns when they are read and dropped.
  		this.boundary = this.newHostBoundary();
		this.agentPolicy = null;
		// Rewind and model-switch facts: one value with total transitions, so the
		// double-dispatch guard, the child-rewind permission and the queued switch
		// are properties of functions instead of conventions re-derived at every
		// call site. `domain/rewind.mjs` owns the transitions.
		this.rewind = createRewindState();
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
		// Every fork capability is one immutable bundle, built from what a missing
		// capability must answer. A reader calls `this.fork.ledger` without a
		// `typeof` probe, and wiring replaces the whole bundle through
		// `bindForkPorts`, never one slot: a capability set that is a function of
		// time cannot be stated as an invariant.
		this.fork = createForkContext({ persistLedger: () => this.persist?.() });
		this.setChildOutcome = null;
		this.forkReports = new Map();
		this.selfForkId = null;
		// The printed-tree baseline and the receipt bookkeeping: one value each.
		this.baseline = createDirectoryBaseline();
		this.projection = createProjectionState();
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

	// -- Fork capability ----------------------------------------------------

	// Read-only facades over the immutable bundle. A caller keeps calling
	// `station.forkLedgerPort()`; the answer is `this.fork.*`. A double that
	// assigns the instance field shadows the facade exactly as it shadowed the
	// old default slot, so no test needs a new convention.
	//
	// A double that never ran the constructor has no bundle; `UNBOUND` answers
	// every capability a missing one must answer, so reading through the same
	// expression on a real station and on a double is always safe.
	forkLedgerPort() {
		return (this.fork ?? UNBOUND).ledger;
	}

	forkOwnerId() {
		return (this.fork ?? UNBOUND).ownerId;
	}

	forkIdentityPort() {
		return (this.fork ?? UNBOUND).identity;
	}

	forkDepthPort() {
		return (this.fork ?? UNBOUND).depth;
	}

	forkWindowPort() {
		return (this.fork ?? UNBOUND).contextWindow;
	}

	forkReservePort() {
		return (this.fork ?? UNBOUND).reserve;
	}

	forkMarginPort() {
		return (this.fork ?? UNBOUND).margin;
	}

	childOutcomePort(forkId) {
		return (this.fork ?? UNBOUND).childOutcome(forkId);
	}

	abortChildrenPort(forkIds, abandonedIds = [], liveIds = forkIds) {
		return (this.fork ?? UNBOUND).abortChildren(forkIds, abandonedIds, liveIds);
	}

	interruptScopePort(forkId) {
		return (this.fork ?? UNBOUND).interruptScope(forkId);
	}

	persistLedger() {
		return (this.fork ?? UNBOUND).persistLedger();
	}

	// The bundle holds the spawner factory, exactly the shape the wiring builds:
	// calling the facade yields the spawner the fork handler invokes per item.
	childSpawnPort() {
		const spawn = (this.fork ?? UNBOUND).spawnChild;
		return typeof spawn === "function" ? spawn() : null;
	}

	noteRootWait(delta) {
		return (this.fork ?? UNBOUND).noteRootWait?.(delta);
	}

	noteScopeRequest() {
		return (this.fork ?? UNBOUND).noteScopeRequest?.();
	}

	/** Replace the whole capability bundle; one injection point, no slot patching. */
	bindFork(fork) {
		if (!fork) return this.fork;
		this.fork = fork;
		if (fork.ledger) {
			this.brackets = fork.ledger;
			if (this.state) this.state.brackets = fork.ledger;
		}
		this.forkWaitPort = () => ({ registry: fork.registry, ledger: fork.ledger });
		this.setChildOutcome = fork.setChildOutcome;
		return { registry: fork.registry, ledger: fork.ledger, identity: fork.identity };
	}

	/**
	 * Build one bundle from plain inputs and install it.
	 *
	 * Wiring supplies the registry, ledger and identity; ownership, depth and
	 * persistence are derived here from those inputs, so no caller repeats the
	 * rules. A later stage patches the bundle by calling this again with the
	 * fields it owns, never by assigning a slot on the station.
	 */
	bindForkPorts({
		registry = undefined,
		ledger = null,
		identity = undefined,
		contextWindow = null,
		reserve = undefined,
		margin = undefined,
		childOutcomePort = null,
		setChildOutcome = null,
		abortChildrenPort = null,
		interruptScopePort = null,
		childSpawnPort = null,
		noteRootWait = null,
		noteScopeRequest = null,
	} = {}) {
		// A test double may borrow this method without running the constructor;
		// the unbound bundle answers every capability a missing one must answer.
		const current = this.fork ?? createUnboundForkContext();
		this.fork = current;
		// An absent argument means "keep what this bundle already says". Only an
		// explicit value replaces a stage fact, so the host stage may re-enter
		// with one capability and leave the base stage's identity intact.
		const nextRegistry = registry === undefined ? current.registry : registry;
		const nextIdentity = identity === undefined ? current.identity : identity;
		// A child persists through its identity; a root keeps the station's own
		// persistence seam. The identity is the only source of that choice.
		const persistLedger =
			typeof nextIdentity?.persistRoot === "function"
				? nextIdentity.persistRoot
				: nextIdentity
					? current.persistLedger
					: () => this.persist?.();
		const nextFork = createForkContext({
				registry: nextRegistry,
				ledger: ledger ?? current.ledger,
				identity: nextIdentity,
				contextWindow: contextWindow ?? current.contextWindow,
				reserve: reserve !== undefined ? reserve : current.reserve,
				margin: margin !== undefined ? margin : current.margin,
				persistLedger,
				interruptScope: interruptScopePort ?? current.interruptScope,
				childOutcome: childOutcomePort ?? current.childOutcome,
				setChildOutcome:
					typeof setChildOutcome === "function"
						? setChildOutcome
						: current.setChildOutcome,
				spawnChild: childSpawnPort ?? current.spawnChild,
				abortChildren: abortChildrenPort ?? current.abortChildren,
				noteRootWait: noteRootWait ?? current.noteRootWait,
				noteScopeRequest: noteScopeRequest ?? current.noteScopeRequest,
		});
		this.fork = nextFork;
		if (nextFork.ledger) {
			this.brackets = nextFork.ledger;
			if (this.state) this.state.brackets = nextFork.ledger;
		}
		this.forkWaitPort = () => ({ registry: nextFork.registry, ledger: nextFork.ledger });
		this.setChildOutcome = nextFork.setChildOutcome;
		return {
			registry: this.fork.registry,
			ledger: this.fork.ledger,
			identity: this.fork.identity,
		};
	}

	// -- Usage ledger ---------------------------------------------------------

	// The measured usage facts live in ../scope/usage-ledger.mjs. Siblings read
	// the ledger's public fields through `station.usage`; there is no forwarding
	// property layer, because a getter per field hides nothing.

	onUsageMessage(message, ctx) {
		this.finishRequestSample(Date.now(), message);
		this.usage.onMessage(message, ctx);
		this.noteDirectoryUsage(message);
		// The baseline advances only on an assistant reply that was neither
		// aborted nor failed; the kernel owns that rule.
		settleBaseline(this.baselineState(), message);
	}

	measuredOccupancy() {
		// The reduction lives in the usage kernel: input plus output, null when no
		// request was measured. Output is optional, so a provider that reports only
		// input does not lose the cost of the request.
		return occupancyOf(this.usage);
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
  			const seededDirBaseline =
  				ledger.root?.dirContextTokens == null && Number.isFinite(baseline);
  			updateRootMeta(ledger, {
  				contextTokens: occupancy,
  				...(seededDirBaseline ? { dirContextTokens: baseline } : {}),
  			});
  			// The usage ledger persists before this write, so the directory copy of
  			// the birth needs its own flush: a process that exits after its first
  			// response must still restore that birth instead of re-measuring one.
  			if (seededDirBaseline) this.persist();
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
		resetBaseline(this.baselineState());
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
			return contextForLeaf(this.boundaryState(), leafId, () => {
				const context = manager?.buildSessionContext?.();
				return Array.isArray(context?.messages) ? context.messages : [];
			});
		} catch {
			forgetContextCache(this.boundaryState());
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
		// The kernel owns the "sequence unchanged and nothing staged" shortcut, so
		// a retry prints the identical delta instead of re-projecting the tree.
		return computeDirectoryDelta(this.baselineState(), ledger);
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
		const runningByRole = runningCountsByRole(ledger);
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
			featureScope: this.state?.features?.scope ?? "hard",
			unreceived: ledger ? unreceivedChildren(ledger, ownerId ?? "root").length : 0,
			canStop: this.state?.relay?.canStop === true,
			contextOverHalf: this.contextNudgeArmed(),
			abandoned,
			remaining: clock ? forkRemaining(record, Date.now(), clock) : null,
			selfPath,
			role: selfPath === "/" ? "manager" : (record?.role ?? roleOfPath(selfPath)),
			scopesDelta,
			runningByRole,
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
		// One projection, one call site (`domain/projection.mjs`); the printed
		// directory snapshot is staged there so the receipt cannot re-derive it.
		const projection = project(snapshot);
		stageDirMeta(this.projectionState(), snapshot);
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
		// One commit path for a join, shared with the waiting ticket.
		return finalizeJoinRecord(this, toolCallId, record, frameId);
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
		// Releasing only the dispatch marker keeps `rewoundThisTurn` for the stop
		// nudge that follows the turn being replaced.
		settleRootRewind(this.rewindState(), plan, committed);
		return committed;
	}

	abortRootRewind(plan = null) {
		return clearPendingRootRewind(this, plan);
	}

	finishRewind(options = {}) {
		return finishRewind(this, options);
	}

	// -- Rewind and model switch (one state, total transitions) ----------------

	/**
	 * The one rewind value, created on first use.
	 *
	 * A test double built with `Object.create(SessionStation.prototype)` never ran
	 * the constructor; creating the value lazily here keeps every transition
	 * total on a real station and on such a double alike.
	 */
	rewindState() {
		if (!this.rewind) this.rewind = createRewindState();
		return this.rewind;
	}

	/** True while this exact plan is already dispatching. */
	isRootRewindBusy(plan) {
		return rootDispatchBusy(this.rewindState(), plan);
	}

	/** Claim this turn: mark the dispatch and consume the stop nudge. */
	armRootRewind(plan) {
		markRootDispatch(this.rewindState(), plan?.pending ?? null);
		this.noteRewoundTurn();
		return plan?.pending ?? null;
	}

	/** A synchronous commit already replaced the turn. */
	noteRewoundTurn() {
		this.rewindState().rewoundThisTurn = true;
		return true;
	}

	/** True once for the turn a rewind committed; the stop nudge skips it. */
	consumeRewoundTurn() {
		const state = this.rewindState();
		if (state.rewoundThisTurn !== true) return false;
		state.rewoundThisTurn = false;
		return true;
	}

	clearRootRewind() {
		clearRootRewind(this.rewindState());
	}

	/** True while a switch is queued or in flight; a new observation must not queue. */
	hasQueuedModelSwitch() {
		return modelSwitchBusy(this.rewindState());
	}

	hasModelSwitchInFlight() {
		return this.rewindState().modelSwitchInFlight !== null;
	}

	hasPendingModelSwitch() {
		return this.rewindState().modelSwitch !== null;
	}

	queueModelSwitchRequest(request) {
		return queueModelSwitch(this.rewindState(), request);
	}

	takeModelSwitchRequest() {
		return takeModelSwitch(this.rewindState());
	}

	settleModelSwitchRequest(request) {
		settleModelSwitch(this.rewindState(), request);
	}

	// -- Child rewind (sync state; the spawn ticket stages and consumes) --------

	/**
	 * Can this child rewind at all? The host proved whether it can branch, and
	 * the manager must be able to reset its leaf and rebuild a context.
	 */
	isChildRewindPermitted() {
		return childRewindPermitted(this.rewindState(), this.manager);
	}

	/** The host proved it cannot branch: refuse every future child rewind. */
	disableChildRewind() {
		disableChildRewind(this.rewindState());
		return this;
	}

	/** Decide once, from the branch the child was created on, whether it may rewind. */
	adoptChildBranch(manager, rewindable) {
		const state = this.rewindState();
		state.childAvailable =
			rewindable === true &&
			typeof manager?.branch === "function" &&
			typeof manager?.resetLeaf === "function";
		return state.childAvailable;
	}

	/** Stage the one plan the spawn ticket consumes after the loop stops. */
	stageChildRewind(plan) {
		return stageChildRewind(this.rewindState(), plan ?? {});
	}

	hasPendingChildRewind() {
		return hasPendingChildRewind(this.rewindState());
	}

	/**
	 * Take the staged plan and clear the slot in one synchronous step, so a
	 * second consumer of the same return cannot rewind twice.
	 */
	consumeChildRewind() {
		return consumeChildRewind(this.rewindState());
	}

	/**
	 * Rewrite the live branch for a child rewind.
	 *
	 * The spawn ticket waits for in-flight persistence, then asks for this; it
	 * never resets a leaf, branches a manager or writes a host message list
	 * itself. `originEntryId === null` means "the branch had no origin": the
	 * leaf is reset instead of moved.
	 */
	commitChildRewind(ctx, plan = {}) {
		const manager = this.manager ?? null;
		if (!manager) return false;
		if (plan.originEntryId === null || plan.originEntryId === undefined) {
			manager.resetLeaf();
		} else {
			manager.branch(plan.originEntryId);
		}
		const rebuilt =
			typeof manager.buildSessionContext === "function"
				? manager.buildSessionContext()?.messages
				: null;
		// The host list is written through the one declared capability; a host
		// that answers false leaves the in-process fallback to the caller, which
		// owns that session object.
		const setOnHost = this.host?.session?.setMessages;
		const applied =
			Array.isArray(rebuilt) && typeof setOnHost === "function"
				? setOnHost(ctx, rebuilt) === true
				: false;
		this.finishRewind({ rebaseAnchor: true });
		return { rebuilt, applied };
	}

	// -- Host-facing reads and cache ownership ---------------------------------

	/**
	 * What a host row prints, in one read-only bundle.
	 *
	 * The host used to poke `state.relay.goal`, `manager` and the fork identity
	 * port from three call sites. One getter keeps the station's shape out of the
	 * host layer: when a field moves, only this body changes.
	 */
	displayContext() {
		return {
			goal: this.state?.relay?.goal === true,
			manager: this.manager ?? null,
			identity: (this.fork ?? UNBOUND).identity,
		};
	}

	/** The one failure entry point; the diagnostics ring is the real history. */
	noteFailure(domain, error, detail = undefined) {
		return this.noteError(domain, error, detail);
	}

	/** Drop the leaf projection, forcing the next `contextMessages` to rebuild. */
	clearContextCache() {
		forgetContextCache(this.boundaryState());
	}

	/** Drop the boundary scan; the last committed key still answers. */
	clearHostBoundaryScan() {
		clearScan(this.boundaryState());
	}

	/**
	 * The host-boundary cache, created on first use.
	 *
	 * A test double built with `Object.create(SessionStation.prototype)` never ran
	 * the constructor, so reading the value through an accessor keeps every
	 * transition total on a real station and on such a double alike.
	 */
  	boundaryState() {
  		if (!this.boundary) this.boundary = this.newHostBoundary();
  		return this.boundary;
  	}

  	/**
  	 * The boundary cache seeded from the persisted key.
  	 *
  	 * A snapshot written before the key was persisted cannot say which handoff
  	 * it already absorbed, so the first observation adopts the transcript's key
  	 * instead of moving to it.
  	 */
  	newHostBoundary() {
  		const state = this.state ?? null;
  		return createHostBoundary(state?.hostBoundaryKey ?? null, {
  			adoptFirst: state ? hasLegacyUnknownHostBoundary(state) : false,
  		});
  	}

	/** The printed-tree baseline, created on first use. */
	baselineState() {
		if (!this.baseline) this.baseline = createDirectoryBaseline();
		return this.baseline;
	}

	/** The receipt bookkeeping, created on first use. */
	projectionState() {
		if (!this.projection) this.projection = createProjectionState();
		return this.projection;
	}

	/**
	 * A moved boundary means the host dropped inner scopes: truncate the state,
	 * reset the directory and usage caches, and persist. The station owns the
	 * fields; a gate only translates the event.
	 */
  	noteHostBoundary(messages) {
  		const moved = observeHostBoundary(this.boundaryState(), messages);
  		if (moved.adopted === true) {
  			this.state.hostBoundaryKey = moved.key;
  			this.persist();
  			return false;
  		}
  		if (moved.changed !== true) return false;
  		this.state.hostBoundaryKey = moved.key;
  		truncateForHostBoundary(this.state);
  		this.resetDirectoryBaseline();
  		this.resetUsageWatermark();
  		this.persist();
  		return true;
  	}

  	/** Accept the live transcript as the boundary after a host compact. */
  	markHostBoundaryCurrent(messages) {
  		const key = syncHostBoundary(this.boundaryState(), messages);
  		this.state.hostBoundaryKey = key;
  		return key;
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
		// The kernel advances the printed tool set and renders the receipt; the
		// directory snapshot it printed is staged as the next baseline candidate,
		// which only becomes the baseline once a real reply lands.
		const text = renderReceipt(this.projectionState(), projection, {
			chinese: this.state?.features?.chinese ?? "on",
		});
		stageScan(this.baselineState(), this.projectionState().lastDirMeta);
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

