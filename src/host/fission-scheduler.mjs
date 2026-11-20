// Fission batch scheduler: one begin receipt, N peer flows, one shared journal.
//
// Control port (called by the scope tool before and after the owner retires):
//
//   registerBatch({ toolCallId, sessionManager, station, ctx, begin, flows,
//                   totals, stage, elderReport, mainAgent, nested, identity })
//       Validates the whole batch without spawning or charging anything, writes
//       the batch's scope.begin entry, and returns a pending batch. The control
//       handler reserves the flow budgets on the owner's current scope right
//       after this call returns; the batch scope opens at start on top of that
//       one reservation. Charging here as well would debit a second scope for
//       the same allocation and leave the batch scope empty.
//
//   retireOwner({ batch, station, ctx })
//       Aborts the owner agent. The host persists the toolResult after
//       afterToolCall returns, so onOwnerEnd can still find it.
//
//   onOwnerEnd({ batch, station, ctx, event })
//       Finds the persisted ack, spawns one AgentSession per flow, writes each
//       flow's scope.begin under the ack, seeds its prefix, binds its flowId to
//       the station, and starts every prompt.
//
// Runtime port (called by wiring/UI):
//
//   flowEnded(flowId, info)     agent_end without an event subscription
//   cancelFlow / cancelAll / noteCostCap / broadcast
//   status / batchStatus / listFlows / activeLeaves / waitForBatch / dispose
//
// Binding contract: a flow is bound by its id string. The id is the value the
// host reports as session.getAgentId() and as ctx.agent.id, and it is the
// flowId passed to bindFlow(flowId, station, permission, { batchId, index,
// label, manager }).
//
// Explicit failure. This module does not imitate host abilities:
//   * Missing SessionManager methods stop construction.
//   * Atomic handoff needs appendEntriesAtomically(), ingestReplicatedEntry()
//     and a persistent session file; otherwise the batch is refused.
//   * Incomplete handoffs from a crash are retired; a record that names its
//     source range, recipient tail, and depth shift is rewritten from it.
//   * levelTemplate is required so copied "scope level N" text is shifted.
//   * A missing setModel() is reported and the batch ends failed with outcome
//     closed-with-adoption-failure instead of claiming a clean succession.
//   * Flow AgentSessions are never disposed: the host dispose path seals the
//     shared SessionManager.
//
// Residual risk. The host exposes no quiescence guarantee. finishFlow awaits
// settleInFlightMessagePersistence() and yields one maintenance tick before
// writing scope.end, but a late agent_end maintenance write can still land
// outside the copied window, or on another leaf, because flow sessions stay
// alive. Handoff therefore waits for the flow's own settle signal, not for the
// host to prove it has stopped writing; treat that as a known limitation.
//
// Flow tails are derived from the journal. The host appends through the shared
// manager directly, so a cached tail goes stale after the first turn. tailOf()
// returns the newest entry whose parent chain reaches the flow's begin entry.
//
// Session continuity. Every boundary the scheduler writes around a flow or a
// batch also enters the heir's messages, in journal order: the flow's begin
// when it starts, then the heir's own scope.end, then the batch scope.end.
// The heir's own scope closes before promotion, so the batch scope is on top
// when finalization closes it and the owner's depth returns to its parent.
// A cost-cap rejection is a cancellation with a different cause, never a crash:
// only the capped flow stops, its siblings keep running, and the batch reports
// cost-capped once the last flow stops.
//
// Per-flow receipts. Every flow sees the same scope-begin tool call; each
// branch then carries its own toolResult naming that flow's intent, budget,
// permission, and model. The disk chain is toolCall -> batch begin -> receipt
// -> flow begin, and the owner's ack stays off every flow branch. In model
// context the receipt directly follows the call and the batch boundary follows
// the receipt, so the provider's call/result pairing stays adjacent.

import { beginScope, closeScope, splitFissionBudget, validateFission } from "../scope/accounting.mjs";
import { createFlowState } from "../scope/state.mjs";
import {
	appendAt,
	copyHandoff,
	handoffMessages,
	incompleteHandoffs,
	levelPattern,
	planHandoffRecovery,
	recoverIncompleteHandoffs,
} from "../transcript/fission.mjs";
import { installFissionEvents } from "./fission-events.mjs";
import { createFissionSession, deriveFissionConfig } from "./fission-session.mjs";
import { isFissionManager } from "./fission-manager.mjs";
import { ownerRetirement } from "../station/retirement.mjs";

export const FISSION_SCHEDULER_CODES = Object.freeze({
	UNSUPPORTED: "FISSION_UNSUPPORTED",
	INVALID_REQUEST: "FISSION_INVALID_REQUEST",
	ACK_MISSING: "FISSION_ACK_MISSING",
	BATCH_BEGIN_MISSING: "FISSION_BATCH_BEGIN_MISSING",
	BATCH_SCOPE_MISSING: "FISSION_BATCH_SCOPE_MISSING",
	OWNER_BUSY: "FISSION_OWNER_BUSY",
	OWNER_RETIRED: "FISSION_OWNER_RETIRED",
	SESSION_UNSUPPORTED: "FISSION_SESSION_UNSUPPORTED",
	SPAWN_FAILED: "FISSION_SPAWN_FAILED",
	MODEL_UNRESOLVED: "FISSION_MODEL_UNRESOLVED",
	HANDOFF_RECOVERY_REQUIRED: "FISSION_HANDOFF_RECOVERY_REQUIRED",
	HANDOFF_RECOVERY_UNSAFE: "FISSION_HANDOFF_RECOVERY_UNSAFE",
	HANDOFF_VIBE_ACTIVE: "FISSION_HANDOFF_VIBE_ACTIVE",
	HANDOFF_FAILED: "FISSION_HANDOFF_FAILED",
	NO_HEIR: "FISSION_NO_HEIR",
	FLOW_NOT_FOUND: "FISSION_FLOW_NOT_FOUND",
	FLOW_NOT_RUNNING: "FISSION_FLOW_NOT_RUNNING",
	PARENT_CLOSED: "FISSION_PARENT_CLOSED",
	NO_ACTIVE_FLOW: "FISSION_NO_ACTIVE_FLOW",
	SCHEDULER_BUSY: "FISSION_SCHEDULER_BUSY",
});

export class FissionSchedulerError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.name = "FissionSchedulerError";
		this.code = code;
		this.details = details;
	}
}

const MANAGER_METHODS = [
	"getBranch",
	"getEntry",
	"getEntries",
	"getLeafId",
	"branch",
	"resetLeaf",
	"appendMessage",
	"appendCustomEntry",
];
const HANDOFF_METHODS = ["appendEntriesAtomically", "getSessionFile", "ingestReplicatedEntry"];
const TERMINAL = new Set(["closed", "cancelled", "crashed"]);
const COST_CAP_CODES = new Set([
	"COST_CAP",
	"COST_CAP_EXCEEDED",
	"COST_LIMIT_EXCEEDED",
	"MAX_COST_EXCEEDED",
]);
const SHARED_STATE_FIELDS = new Set(["herdMode", "relay", "stageFlags", "pins"]);
const TOOL_RESULT_ROLES = new Set(["toolResult", "tool_result", "tool"]);

function isObject(value) {
	return value !== null && typeof value === "object";
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

// The host raises a CostCapError when the shared gate refuses a request. Match
// the class name and the conventional codes, and follow a wrapped cause; a
// message substring is not a classification.
function isCostCapError(error) {
	if (!isObject(error)) return false;
	if (error.name === "CostCapError") return true;
	if (typeof error.code === "string" && COST_CAP_CODES.has(error.code)) return true;
	return error.cause && error.cause !== error ? isCostCapError(error.cause) : false;
}

function missingMethods(target, names) {
	return names.filter((name) => typeof target?.[name] !== "function");
}

function refusal(code, message, details = {}) {
	return new FissionSchedulerError(code, message, details);
}

function tokenFor(value) {
	const token = String(value ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-32);
	return token || "0";
}

function maxHandoffId(entries) {
	let max = 0;
	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== "fission.handoff.begin") continue;
		const value = entry.data?.handoffId;
		if (Number.isSafeInteger(value) && value > max) max = value;
	}
	return max;
}

function sumBudgets(items) {
	const totals = {};
	for (const item of items) {
		for (const [tool, amount] of Object.entries(item.budget ?? {})) {
			totals[tool] = (totals[tool] ?? 0) + amount;
		}
	}
	return totals;
}

function sameCounts(left, right) {
	const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
	for (const key of keys) {
		if ((left?.[key] ?? 0) !== (right?.[key] ?? 0)) return false;
	}
	return true;
}

/**
 * True when `candidate` is the scheduler's manager or a flow proxy over it.
 *
 * A flow's station carries the proxy that isolates its leaf, not the raw
 * manager the scheduler was built over. The proxy exposes the manager it
 * wraps, so registration unwraps one proxy before comparing identity. A proxy
 * over a different journal still fails, because its shared manager is not this
 * scheduler's journal.
 */
function sharesSharedManager(candidate, manager) {
	if (candidate === manager) return true;
	if (!isFissionManager(candidate)) return false;
	return candidate.shared === manager;
}

function findToolResultId(manager, toolCallId) {
	if (!isNonEmptyString(toolCallId)) return null;
	const entries = manager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		const message = entry?.type === "message" ? entry.message : undefined;
		if (!message || !TOOL_RESULT_ROLES.has(message.role)) continue;
		// A per-flow receipt shares the batch's toolCallId. The owner's ack is
		// the result the control path persisted, never a flow receipt.
		if (message.details?.fissionReceipt) continue;
		if (message.toolCallId === toolCallId || message.toolCallID === toolCallId) return entry.id;
	}
	return null;
}

/**
 * Create the scheduler for one owner session.
 *
 * Required: manager, session, bindFlow(flowId, station, permission, meta),
 * levelTemplate, vibeActive.
 * Optional: agent, state, bridge, spawnFlow, resolveModel, asyncJobManager,
 * costGate, agentRegistry, settings, cwd, systemPrompt, toolNames,
 * activeToolNames, mountedToolNames, enableLsp, enableMCP, mcpManager, mcpTools,
 * mcpToolScope, createAgentSession, thinkingLevel, mainAgent, relayOn, persist,
 * onPromote, onBatchEvent, onFlowEvent, unbindFlow, allowIncompleteHandoffs.
 */
export function createFissionScheduler(options = {}) {
	const manager = options.manager;
	if (!isObject(manager)) {
		throw refusal(FISSION_SCHEDULER_CODES.UNSUPPORTED, "a shared SessionManager is required");
	}
	const missingManager = missingMethods(manager, MANAGER_METHODS);
	if (missingManager.length > 0) {
		throw refusal(
			FISSION_SCHEDULER_CODES.UNSUPPORTED,
			`the shared SessionManager lacks ${missingManager.join(", ")}`,
			{ missing: missingManager },
		);
	}
	const missingHandoff = missingMethods(manager, HANDOFF_METHODS);
	if (missingHandoff.length > 0) {
		throw refusal(
			FISSION_SCHEDULER_CODES.UNSUPPORTED,
			`atomic handoff needs ${missingHandoff.join(", ")}`,
			{ missing: missingHandoff },
		);
	}
	if (manager.getSessionFile() === undefined || manager.getSessionFile() === null) {
		throw refusal(
			FISSION_SCHEDULER_CODES.UNSUPPORTED,
			"atomic handoff needs a persistent session file",
		);
	}

	const ownerSession = options.session;
	if (!isObject(ownerSession)) {
		throw refusal(FISSION_SCHEDULER_CODES.UNSUPPORTED, "the owner AgentSession is required");
	}
	const ownerAgent = options.agent ?? ownerSession.agent;
	if (!isObject(ownerAgent)) {
		throw refusal(FISSION_SCHEDULER_CODES.UNSUPPORTED, "the owner agent is required");
	}
	assertAgentShape(ownerAgent);
	if (typeof options.bindFlow !== "function") {
		throw refusal(
			FISSION_SCHEDULER_CODES.UNSUPPORTED,
			"bindFlow(flowId, station, permission, meta) is required",
		);
	}
	if (typeof options.vibeActive !== "boolean" && typeof options.vibeActive !== "function") {
		throw refusal(
			FISSION_SCHEDULER_CODES.UNSUPPORTED,
			"vibeActive must be a boolean or a function",
		);
	}

	let levelRegex;
	try {
		levelRegex = levelPattern(options.levelTemplate);
	} catch (error) {
		throw refusal(
			FISSION_SCHEDULER_CODES.UNSUPPORTED,
			"levelTemplate must contain {{level}}; copied history cannot be shifted without its anchor",
			{ cause: error?.message },
		);
	}

	const bridge = options.bridge ?? installFissionEvents(ownerSession);
	const ownsBridge = options.bridge === undefined;

	const batches = [];
	const batchesById = new Map();
	const limits = [];
	let batchSerial = 0;
	let broadcastSeq = 0;
	let handoffSeq = maxHandoffId(manager.getEntries());
	let disposed = false;

	function assertAgentShape(agent) {
		if (!isObject(agent?.state) || !Array.isArray(agent.state.messages)) {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				"agent.state.messages is not an array; handoff injection cannot reach the model",
			);
		}
		if (typeof agent.reset !== "function") {
			throw refusal(FISSION_SCHEDULER_CODES.UNSUPPORTED, "agent.reset() is required for adoption");
		}
	}

	function recordLimit(code, detail, meta = {}) {
		if (limits.some((limit) => limit.code === code && limit.flowId === meta.flowId)) return;
		limits.push({ code, detail, ...meta });
	}

	function emit(batch, type, data = {}) {
		try {
			options.onBatchEvent?.({ type, batchId: batch.id, ...data });
		} catch {
			// An observer must not break the scheduler.
		}
	}

	function vibeIsActive() {
		const value = options.vibeActive;
		const active = typeof value === "function" ? value() : value;
		if (typeof active !== "boolean") {
			throw refusal(FISSION_SCHEDULER_CODES.UNSUPPORTED, "vibeActive() must return a boolean");
		}
		return active;
	}

	function costCapError(error) {
		if (typeof options.isCostCapError === "function") {
			try {
				return options.isCostCapError(error) === true;
			} catch {
				// A classifier that throws is not a match.
			}
		}
		return isCostCapError(error);
	}

	function gateOptions(request = {}) {
		const mainAgent = typeof request.mainAgent === "boolean"
			? request.mainAgent
			: typeof options.mainAgent === "function"
				? Boolean(options.mainAgent())
				: options.mainAgent === true;
		const relayOn = typeof options.relayOn === "function"
			? Boolean(options.relayOn())
			: options.relayOn === true;
		return { mainAgent, relayOn };
	}

	function resolveModel(item, owner) {
		if (item.model === undefined || item.model === null) {
			const inherited = owner.session?.model;
			if (!inherited) {
				throw refusal(
					FISSION_SCHEDULER_CODES.MODEL_UNRESOLVED,
					"flow model is null but the owner session has no model",
				);
			}
			return inherited;
		}
		if (typeof options.resolveModel !== "function") {
			throw refusal(
				FISSION_SCHEDULER_CODES.MODEL_UNRESOLVED,
				`flow requests model ${item.model} but no resolveModel() was supplied`,
			);
		}
		const model = options.resolveModel(item.model);
		if (!model) {
			throw refusal(
				FISSION_SCHEDULER_CODES.MODEL_UNRESOLVED,
				`resolveModel(${item.model}) returned nothing`,
				{ model: item.model },
			);
		}
		return model;
	}

	function sessionOptions(batch, plan) {
		return {
			session: batch.owner.session,
			sessionManager: manager,
			flowId: plan.flowId,
			label: plan.label,
			model: plan.model,
			asyncJobManager: options.asyncJobManager,
			costGate: options.costGate,
			agentRegistry: options.agentRegistry,
			settings: options.settings,
			cwd: options.cwd,
			systemPrompt: options.systemPrompt,
			toolNames: options.toolNames,
			activeToolNames: options.activeToolNames,
			mountedToolNames: options.mountedToolNames,
			enableLsp: options.enableLsp === true,
			enableMCP: options.enableMCP === true,
			mcpManager: options.mcpManager,
			mcpTools: options.mcpTools,
			mcpToolScope: options.mcpToolScope,
			createAgentSession: options.createAgentSession,
			thinkingLevel: options.thinkingLevel,
		};
	}

	async function spawnFlow(batch, plan) {
		if (typeof options.spawnFlow === "function") {
			const result = await options.spawnFlow({
				batch,
				flowId: plan.flowId,
				label: plan.label,
				item: plan.item,
				model: plan.model,
				sessionManager: manager,
				owner: batch.owner,
			});
			if (!result?.session) {
				throw refusal(
					FISSION_SCHEDULER_CODES.SPAWN_FAILED,
					`spawnFlow refused ${plan.flowId}: ${result?.detail ?? result?.reason ?? "no session"}`,
					{ flowId: plan.flowId },
				);
			}
			return { session: result.session, limitations: result.limitations ?? [] };
		}
		const created = await createFissionSession(sessionOptions(batch, plan));
		if (!created.ok) {
			throw refusal(
				FISSION_SCHEDULER_CODES.SESSION_UNSUPPORTED,
				`${plan.flowId}: ${created.detail}`,
				{ flowId: plan.flowId, reason: created.reason },
			);
		}
		return { session: created.session, limitations: created.limitations ?? [] };
	}

	function promptFor(flow) {
		if (typeof flow.session?.prompt === "function") {
			return (message) => flow.session.prompt(message);
		}
		if (typeof flow.agent?.prompt === "function") {
			return (message) => flow.agent.prompt(message);
		}
		return null;
	}

	// The default event bridge only multiplexes the owner session; it exposes
	// accept() rather than attach(). Wiring may inject a bridge that knows how
	// to attach a flow source. Either port is honoured, and neither is guessed.
	function attachBridge(flow, source) {
		if (typeof bridge.attach === "function") return bridge.attach(flow.id, source);
		if (typeof bridge.accept !== "function") {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				`event bridge for ${flow.id} exposes neither attach() nor accept()`,
				{ flowId: flow.id },
			);
		}
		return source.subscribe((event) => bridge.accept(flow.id, event));
	}

	// A flow needs its own station. The registry keys flows by identity and
	// refuses to bind two flows to one station, and every flow owns an
	// independent scope stack. The view shares the immutable collaborators
	// (manager, tickets, registry) and inherits the station methods, while every
	// flow-local field becomes an own property. The usage ledger stays bound to
	// the owner's state; that gap is reported as a limit, never hidden.
	function newFlowStation(base, flow) {
		if (typeof options.createFlowStation === "function") {
			return options.createFlowStation(base, flow, flow.batch);
		}
		if (!isObject(base)) return base;
		const view = Object.create(base);
		view.state = flow.state;
		view.fissionFlow = null;
		view.pendingFission = null;
		view.ownerRetired = null;
		view.lastPersisted = null;
		view.lastStateEntryId = null;
		view.stateWrites = 0;
		view.handled = new Map();
		view.processedCalls = new Set();
		view.processedMessages = new Set();
		view.callGroups = new Map();
		view.preparingMessage = null;
		view.dispatchMessage = null;
		view.dispatchPositions = new Map();
		view.dispatchHasScope = false;
		view.nudged = new WeakSet();
		view.lastError = null;
		view.agentPolicy = null;
		view.handoffReport = null;
		view.todoGrantKey = null;
		view.pendingModelSwitch = null;
		view.modelSwitchInFlight = null;
		recordLimit(
			"FLOW_STATION_SHARES_USAGE_LEDGER",
			"The flow station view shares the owner's usage ledger, so flow usage is measured against the owner's scope state.",
			{ flowId: flow.id },
		);
		return view;
	}

	function subscribeSource(flow) {
		if (typeof flow.session?.subscribe === "function") return flow.session;
		if (typeof flow.agent?.subscribe === "function") return flow.agent;
		throw refusal(
			FISSION_SCHEDULER_CODES.UNSUPPORTED,
			`flow ${flow.id} exposes no subscribe()`,
			{ flowId: flow.id },
		);
	}

	// -- Journal-derived structure -------------------------------------------

	function isDescendant(entry, ancestorId, byId) {
		let current = entry;
		for (let guard = 0; current && guard < 100000; guard += 1) {
			if (current.id === ancestorId) return true;
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return false;
	}

	function tailOf(flow) {
		if (!flow.beginId) return null;
		const entries = manager.getEntries();
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			if (isDescendant(entries[index], flow.beginId, byId)) return entries[index].id;
		}
		return flow.beginId;
	}

	function depthAt(entryId) {
		let depth = 0;
		for (const entry of manager.getBranch(entryId)) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "scope.begin") depth += 1;
			else if (entry.customType === "scope.end") depth -= 1;
		}
		return depth;
	}

	function sourceSegment(record) {
		const branch = manager.getBranch(record.to);
		const start = branch.findIndex((entry) => entry.id === record.from);
		if (start < 0) {
			throw refusal(
				FISSION_SCHEDULER_CODES.HANDOFF_FAILED,
				`handoff ${record.handoffId}: source begin is not on the end branch`,
				{ handoffId: record.handoffId },
			);
		}
		const segment = branch.slice(start);
		if (segment[0]?.id !== record.from || segment.at(-1)?.id !== record.to) {
			throw refusal(
				FISSION_SCHEDULER_CODES.HANDOFF_FAILED,
				`handoff ${record.handoffId}: window is not contiguous`,
				{ handoffId: record.handoffId },
			);
		}
		return segment;
	}

	// -- State ----------------------------------------------------------------

	function createBatch(request) {
		batchSerial += 1;
		const identityId = request.identity?.id ?? request.ctx?.agent?.id ?? null;
		const parentFlow = request.nested ? findFlow(identityId) : null;
		if (request.nested && !parentFlow) {
			throw refusal(
				FISSION_SCHEDULER_CODES.FLOW_NOT_FOUND,
				`nested batch owner ${String(identityId)} is not a live flow`,
				{ flowId: identityId },
			);
		}
		if (parentFlow && isTerminal(parentFlow)) {
			throw refusal(
				FISSION_SCHEDULER_CODES.FLOW_NOT_RUNNING,
				`nested batch owner ${parentFlow.id} is already ${parentFlow.status}`,
				{ flowId: parentFlow.id },
			);
		}
		// A flow that opened a nested batch was aborted when that batch
		// retired. Its status can still read "running" until the inner batch
		// resolves, so the domain state decides: one live nested batch per flow.
		if (
			parentFlow &&
			(parentFlow.nestedSealed === true ||
				parentFlow.batch?.finalizing === true ||
				parentFlow.batch?.done === true)
		) {
			throw refusal(
				FISSION_SCHEDULER_CODES.PARENT_CLOSED,
				`nested batch owner ${parentFlow.id} is closing and cannot accept a child batch`,
				{ flowId: parentFlow.id, batchId: parentFlow.batch?.id ?? null },
			);
		}
		const liveRetired = parentFlow?.nested?.find(
			(child) => child.ownerRetired === true && child.done !== true,
		);
		if (liveRetired) {
			throw refusal(
				FISSION_SCHEDULER_CODES.OWNER_RETIRED,
				`nested batch owner ${parentFlow.id} retired when batch ${liveRetired.id} opened; the flow cannot open another batch`,
				{ flowId: parentFlow.id, batchId: liveRetired.id },
			);
		}
		const owner = parentFlow
			? { session: parentFlow.session, agent: parentFlow.agent, state: parentFlow.state }
			: { session: ownerSession, agent: ownerAgent, state: request.station?.state ?? options.state };
		if (!isObject(owner.state)) {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				"station.state is required; flow states are derived from it",
			);
		}
		const token = tokenFor(request.toolCallId);
		const id = `b${token}x${batchSerial}`;
		const label = parentFlow ? `${parentFlow.label}/${id}` : id;
		let resolveDone;
		const donePromise = new Promise((resolve) => {
			resolveDone = resolve;
		});
		return {
			id,
			serial: batchSerial,
			label,
			stage: request.stage,
			intent: null,
			toolCallId: request.toolCallId,
			station: request.station,
			ctx: request.ctx,
			identity: request.identity,
			begin: request.begin,
			items: [],
			totals: {},
			owner,
			parentFlow,
			parentBatch: parentFlow?.batch ?? null,
			flows: [],
			status: "registered",
			heir: null,
			carryOver: [],
			costCapped: false,
			cancelled: false,
			ownerRetired: false,
			ownerEnded: false,
			batchBeginId: null,
			scopeId: null,
			startPromise: null,
			handoffs: [],
			warnings: [],
			limits: [],
			done: false,
			finalizing: false,
			finalizePromise: null,
			flushChain: Promise.resolve(),
			endSeq: 0,
			donePromise,
			resolveDone,
		};
	}

	function resolveBatch(batch, result) {
		if (batch.done) return;
		batch.done = true;
		// The stop guard keeps its own descriptor. Clear it only when it still
		// points at this batch, so a newer batch is never cleared by an older one.
		const station = batch.station;
		const pending = station?.pendingFission;
		if (pending && (pending === batch || pending.batch === batch || pending.batchId === batch.id)) {
			station.pendingFission = null;
		}
		// The batch is terminal and its heir has been adopted. The owner's
		// session may interact again, so the retirement gate ends here.
		station?.clearOwnerRetired?.(batch.id);
		batch.resolveDone(result);
	}

	function isTerminal(flow) {
		return TERMINAL.has(flow.status);
	}

	function subtreeClosed(flow) {
		if (!["ending", "closed", "cancelled", "crashed", "waiting-heir"].includes(flow.status)) {
			return false;
		}
		// A flow that has not sealed its nested set could still accept a child
		// after this check; never call it closed in that state.
		if (flow.nestedSealed !== true) return false;
		return flow.nested.every((batch) => batch.done === true);
	}

	// A successor is any flow that has not written its final boundary yet. An
	// "ending" flow is still a valid receiver: its turn is over, but its
	// scope.end and handoff are not written, so skipping it would let the other
	// flow finalize before this one has enqueued its segment. A flow that has
	// written its end (closed/cancelled/crashed) or is already the heir cannot
	// receive another segment.
	function canReceive(flow) {
		if (!["spawning", "running", "ending"].includes(flow.status)) return false;
		return flow.nested.every((batch) => batch.done === true);
	}

	function nextOpenFlow(batch, sourceIndex) {
		const count = batch.flows.length;
		for (let offset = 1; offset < count; offset += 1) {
			const candidate = batch.flows[(sourceIndex + offset) % count];
			if (candidate && canReceive(candidate)) return candidate;
		}
		return null;
	}

	function copyReady(target) {
		if (!target || target.status === "spawning") return false;
		if (target.nested.some((batch) => batch.done !== true)) return false;
		return target.agent?.state?.isStreaming !== true;
	}

	function findFlow(flowId) {
		if (!isNonEmptyString(flowId)) return null;
		for (const batch of batches) {
			const flow = batch.flows.find((candidate) => candidate.id === flowId);
			if (flow) return flow;
		}
		return null;
	}

	function collectRunning(batch, target = []) {
		if (batch.done) return target;
		// A flow that opened a nested batch has retired: only its innermost
		// running descendants are leaves. Sibling flows of the same batch are
		// still leaves, though, so nesting is resolved per flow rather than
		// replacing the whole batch with the first open child found.
		for (const flow of batch.flows) {
			const leaves = [];
			let opened = false;
			for (const child of flow.nested) {
				if (child.done === true) continue;
				opened = true;
				collectRunning(child, leaves);
			}
			if (leaves.length > 0) {
				target.push(...leaves);
				continue;
			}
			// An open nested batch means this flow already retired into its
			// subtree, so it is never a leaf of this batch itself, even when
			// that subtree yields no running leaf because its last flow is
			// ending. Handing input to such a flow would queue a steer that its
			// own settle retracts when it resumes; the text must travel upward
			// as data instead.
			if (opened) continue;
			// A flow that ran scope({ end: true }) has declared completion even
			// while its status still reads "running" until agent_end. Its only
			// remaining work is closing, so a steer would queue a model call it
			// can no longer show: an invisible turn in an already retired flow.
			// It is not an active leaf for input; the last live flow or the heir
			// receives the text instead.
			// A cancelled flow still reads "running" until its agent_end settles
			// it, but its stream can never show new input: a copy delivered there
			// would be retracted on the next settle and would hold the text
			// against every other recipient in the meantime.
			if (flow.status === "running" && flow.endRequested !== true && !flow.cancelReason) {
				target.push(flow);
			}
		}
		return target;
	}

	function activeLeaves() {
		const leaves = [];
		for (const batch of batches) {
			if (batch.parentBatch || batch.done) continue;
			collectRunning(batch, leaves);
		}
		return [...new Map(leaves.map((flow) => [flow.id, flow])).values()];
	}

	// Broadcast text reaches a flow as a queued steer. If the flow declares
	// completion before its next model call, the host carries that queue into a
	// fresh run after retirement: an invisible turn in a detached stream.
	// Remember every copy we enqueue so retirement can settle it.
	//
	// One ledger row per broadcastId decides where the text is shown. A copy is
	// "queued" on the flow that holds it. "shown" means one conversation already
	// displays the text, because a flow consumed its copy or the heir received
	// it as input. After that no second copy may be delivered, and a flow that
	// retired without consuming is never mistaken for a holder: it can no
	// longer show anything.
	const broadcastLedger = new Map();

	function broadcastRecord(broadcastId, text) {
		let record = broadcastLedger.get(broadcastId);
		if (!record) {
			record = { text, shown: false, copies: new Map(), stuck: new Map() };
			broadcastLedger.set(broadcastId, record);
		}
		return record;
	}

	// A ledger row stops routing while the text may still be delivered a second
	// time: a conversation shows it, the owner took it into its queue, delivery
	// ended in a state where a retry could duplicate it, or a failed retraction
	// left a copy reachable inside a retiring flow. A stuck copy is tracked per
	// flow and re-probed at every settle, so it holds healthy copies back only
	// while it is genuinely still reachable.
	function broadcastSettled(record) {
		return (
			record.shown === true ||
			record.accepted === true ||
			record.unknown === true ||
			record.stuck.size > 0
		);
	}

	function rememberBroadcast(flow, message, broadcastId, text) {
		flow.pendingBroadcasts.push({ message, broadcastId, text });
		broadcastRecord(broadcastId, text).copies.set(flow.id, "queued");
	}

	// Record text that has no conversation left to land in. The warning carries
	// the whole broadcast so it can be recovered, and the ledger keeps its row
	// so a later settle never delivers a second copy to excuse the failure.
	function undeliveredWarning(batch, code, entry, detail) {
		const reason = detail?.error ?? detail?.message ?? detail;
		const warning = {
			code,
			message: reason ? String(reason) : code,
			flowId: detail?.flowId ?? null,
			broadcastId: entry?.broadcastId ?? null,
			text: typeof entry?.text === "string" ? entry.text : null,
		};
		batch.warnings.push(warning);
		emit(batch, "flow.warning", warning);
		return warning;
	}

	function enqueueBroadcast(recipients, text, broadcastId) {
		const labels = recipients.map((flow) => flow.label);
		const delivered = [];
		const failed = [];
		for (const flow of recipients) {
			if (typeof flow.agent?.steer !== "function") {
				const failure = { flowId: flow.id, error: "agent.steer() is unavailable" };
				failed.push(failure);
				undeliveredWarning(flow.batch, "BROADCAST_DELIVERY_FAILED", { broadcastId, text }, failure);
				continue;
			}
			const message = {
				role: "custom",
				customType: "fission.broadcast",
				content: `(broadcast to ${recipients.length} flows)\n\n${text}`,
				display: true,
				details: { fissionBroadcast: { broadcastId, recipients: labels } },
				timestamp: Date.now(),
			};
			try {
				flow.agent.steer(message);
				rememberBroadcast(flow, message, broadcastId, text);
				delivered.push(flow.label);
			} catch (error) {
				const failure = { flowId: flow.id, error: error?.message ?? String(error) };
				failed.push(failure);
				undeliveredWarning(flow.batch, "BROADCAST_DELIVERY_FAILED", { broadcastId, text }, failure);
			}
		}
		return { labels, delivered, failed };
	}

	/**
	 * A flow that stops accepting turns must not run another one. The host
	 * deliberately keeps queued steering across an abort and auto-continues
	 * from it, so a broadcast queued before scope({ end: true }) would become a
	 * silent extra turn in a detached stream. Retract only the copies this flow
	 * holds and has not consumed, then route them onward: a live flow that
	 * holds no copy, or the batch carry ledger that ends at the heir.
	 */
	function settlePendingBroadcasts(flow) {
		const pending = Array.isArray(flow.pendingBroadcasts) ? flow.pendingBroadcasts.splice(0) : [];
		const inherited = Array.isArray(flow.inheritedCarry) ? flow.inheritedCarry.splice(0) : [];
		const consumed = consumedBroadcastIds(flow);
		const unlanded = pending.filter((entry) => !isConsumed(flow, entry, consumed));
		const stuck = retractQueuedCopies(flow, unlanded);
		const released = refreshStuckCopies();
		for (const entry of pending) {
			const record = broadcastRecord(entry.broadcastId, entry.text);
			if (isConsumed(flow, entry, consumed)) {
				record.copies.delete(flow.id);
				record.stuck.delete(flow.id);
				record.shown = true;
				continue;
			}
			if (stuck.has(entry)) {
				// The copy is still reachable inside this retiring flow.
				// Routing a second copy now could show the text twice, so hold
				// routing and report the text instead of pretending the
				// retraction succeeded. The entry stays on record so a later
				// settle can prove it gone and release the other copies.
				record.copies.set(flow.id, "stuck");
				record.stuck.set(flow.id, { flow, entry });
				undeliveredWarning(flow.batch, "BROADCAST_RETRACT_FAILED", entry, { flowId: flow.id });
				continue;
			}
			record.copies.delete(flow.id);
			record.stuck.delete(flow.id);
		}
		for (const entry of pending) {
			if (isConsumed(flow, entry, consumed) || stuck.has(entry)) continue;
			routeBroadcast(flow, entry);
		}
		for (const entry of inherited) routeBroadcast(flow, entry);
		for (const held of released) routeBroadcast(held.flow, held.entry);
	}

	// A copy that could not be proven gone was a fact about one moment, not a
	// life sentence for the ledger row. The host may have dropped it after the
	// abort, or the flow may have shown it after all. Re-probe every held copy
	// at each settle: only a copy whose queues and transcript still lack it is
	// released, and a copy the transcript now shows marks the text as shown.
	function refreshStuckCopies() {
		const released = [];
		for (const record of broadcastLedger.values()) {
			for (const [flowId, held] of record.stuck) {
				const consumed = consumedBroadcastIds(held.flow);
				if (isConsumed(held.flow, held.entry, consumed)) {
					record.stuck.delete(flowId);
					record.copies.delete(flowId);
					record.shown = true;
					continue;
				}
				const isCopy = (message) =>
					message === held.entry.message ||
					message?.details?.fissionBroadcast?.broadcastId === held.entry.broadcastId;
				if (flowStillHoldsCopy(held.flow, held.entry, isCopy, { withdrew: false, withdrawn: [] })) {
					continue;
				}
				record.stuck.delete(flowId);
				record.copies.delete(flowId);
				released.push(held);
			}
		}
		return released;
	}

	// The broadcast ids this flow's own message list already displays. The host
	// may clone a queued message instead of moving the same object, so the id in
	// its details is the reliable witness; object identity is kept for a host
	// that appends the message as-is.
	function consumedBroadcastIds(flow) {
		const messages = Array.isArray(flow.agent?.state?.messages) ? flow.agent.state.messages : [];
		const ids = new Set();
		for (const message of messages) {
			const id = message?.details?.fissionBroadcast?.broadcastId;
			if (typeof id === "string" && id) ids.add(id);
		}
		return ids;
	}

	function isConsumed(flow, entry, consumedIds) {
		if (consumedIds.has(entry.broadcastId)) return true;
		const messages = Array.isArray(flow.agent?.state?.messages) ? flow.agent.state.messages : [];
		return messages.includes(entry.message);
	}

	// The host keeps a queued copy in three places: the pending steering and
	// follow-up queues, the batch it dequeued for the next model call, and the
	// live-steered messages a provider already took into its in-flight
	// response. clearSteeringQueue() touches only the first, and abort()
	// restores the other two, so a whole-queue clear both destroys the user's
	// own input and lets our copy resurface as a ghost turn. Take back only the
	// copies this flow queued: withdraw the undelivered ones before the abort,
	// which makes the host neither record nor requeue them, then strip our
	// messages from both pending queues with peek/replace. Anything that is not
	// ours goes back where it was.
	// Return the entries whose copy could not be proven gone. A missing or
	// throwing read proves nothing, so it counts as still held: routing such a
	// copy onward would show the text a second time if the host ever runs the
	// stale copy.
	//
	// Every host call stands alone. Withdraw, restore, and strip touch
	// different queues and can refuse independently: one failure must not skip
	// the rest of the retraction, and the host's own input must never vanish
	// with it. A refused rewrite is reported with the affected text.
	function retractQueuedCopies(flow, entries) {
		if (entries.length === 0) return new Set();
		const agent = flow.agent;
		const ours = new Set(entries.map((entry) => entry.message));
		const ids = new Set(entries.map((entry) => entry.broadcastId));
		const isCopy = (message) =>
			ours.has(message) ||
			ids.has(message?.details?.fissionBroadcast?.broadcastId);
		const probe = {
			withdrew: false,
			withdrawn: [],
			withdrawnByQueue: { steering: [], followUp: [] },
		};
		// The withdraw is the only call that can prove a provider no longer
		// holds a copy. Its failure is reported, and the pending queues are
		// still stripped below.
		if (typeof agent?.withdrawUndeliveredQueuedMessages === "function") {
			try {
				const withdrawn = agent.withdrawUndeliveredQueuedMessages() ?? {};
				probe.withdrew = true;
				probe.withdrawnByQueue.steering = Array.isArray(withdrawn.steering) ? withdrawn.steering : [];
				probe.withdrawnByQueue.followUp = Array.isArray(withdrawn.followUp) ? withdrawn.followUp : [];
				probe.withdrawn = [
					...probe.withdrawnByQueue.steering,
					...probe.withdrawnByQueue.followUp,
				];
			} catch (error) {
				batchWarning(flow.batch, "FLOW_QUEUE_RETRACT_FAILED", error, flow);
			}
		}
		// The withdraw takes every undelivered message, not only ours. Put the
		// host's own input back one queue at a time: a refusal in one queue
		// never strands the other, and whatever cannot be put back is reported
		// with its text rather than silently lost.
		if (probe.withdrew) {
			for (const queue of ["steering", "followUp"]) {
				const withdrawn = probe.withdrawnByQueue[queue];
				try {
					const restored = requeueKept(agent, queue, withdrawn, isCopy);
					for (const message of restored.lost) {
						reportLostInput(flow, queue, message, restored.error);
					}
				} catch (error) {
					// requeueKept is total by design; this guards a host whose
					// accessors throw, so no message goes unreported.
					for (const message of withdrawn.filter((message) => !isCopy(message))) {
						reportLostInput(flow, queue, message, error);
					}
				}
			}
		}
		// Strip our copies from both pending queues. Each queue stands alone: a
		// throwing read or rewrite of one is reported and the other still runs,
		// because a skipped strip leaves a ghost turn behind.
		for (const queue of ["steering", "followUp"]) {
			const peek = queue === "steering" ? agent?.peekSteeringQueue : agent?.peekFollowUpQueue;
			if (typeof peek !== "function" || typeof agent?.replaceQueue !== "function") continue;
			try {
				const pending = peek.call(agent);
				if (!Array.isArray(pending)) continue;
				const kept = pending.filter((message) => !isCopy(message));
				if (kept.length !== pending.length) agent.replaceQueue(queue, kept);
			} catch (error) {
				batchWarning(flow.batch, "FLOW_QUEUE_RETRACT_FAILED", error, flow);
			}
		}
		const stuck = new Set();
		for (const entry of entries) {
			if (flowStillHoldsCopy(flow, entry, isCopy, probe)) stuck.add(entry);
		}
		return stuck;
	}

	function flowStillHoldsCopy(flow, entry, isCopy, probe) {
		const agent = flow.agent;
		for (const peek of [
			agent?.peekSteeringQueue,
			agent?.peekFollowUpQueue,
			agent?.peekUndeliveredQueuedMessages,
		]) {
			if (typeof peek !== "function") continue;
			let pending;
			try {
				pending = peek.call(agent);
			} catch {
				return true;
			}
			if (Array.isArray(pending) && pending.some(isCopy)) return true;
		}
		if (probe.withdrawn.some(isCopy)) return false;
		// No readable queue lists the copy. A successful withdraw call emptied
		// the undelivered set; without one, an unreadable undelivered set could
		// still hold it.
		return !probe.withdrew && typeof agent?.peekUndeliveredQueuedMessages !== "function";
	}

	// The host withdraws every undelivered message of a run, not only ours. Put
	// the user's own input back at the head of its queue, where the host's abort
	// restoration would have kept it, so preserving our text never costs theirs.
	//
	// Nothing here throws. A message the host handed back and then refused to
	// take again is returned as lost, so the caller can report it with its text
	// instead of letting the exception be its only trace.
	function requeueKept(agent, queue, messages, isCopy) {
		if (!Array.isArray(messages)) return { lost: [], error: null };
		const kept = messages.filter((message) => !isCopy(message));
		if (kept.length === 0) return { lost: [], error: null };
		const peek = queue === "steering" ? agent?.peekSteeringQueue : agent?.peekFollowUpQueue;
		const readQueue = () => {
			if (typeof peek !== "function") return null;
			try {
				const pending = peek.call(agent);
				return Array.isArray(pending) ? pending : null;
			} catch {
				return null;
			}
		};
		let pending = readQueue();
		let error = null;
		if (pending !== null && typeof agent?.replaceQueue === "function") {
			try {
				agent.replaceQueue(queue, [...kept, ...pending]);
				return { lost: [], error };
			} catch (caught) {
				error = caught;
				// A refused rewrite may still have landed; read again before
				// adding a second copy of the user's text.
				pending = readQueue();
				if (pending === null) return { lost: kept, error };
			}
		}
		const missing = pending === null ? kept : kept.filter((message) => !pending.includes(message));
		const lost = [];
		for (const message of missing) {
			try {
				if (queue === "steering") {
					if (typeof agent?.steer !== "function") throw new Error("agent.steer() is unavailable");
					agent.steer(message);
				} else {
					if (typeof agent?.followUp !== "function") throw new Error("agent.followUp() is unavailable");
					agent.followUp(message);
				}
			} catch (caught) {
				error ??= caught;
				lost.push(message);
			}
		}
		if (lost.length === 0) return { lost, error };
		// Trust an append only when the queue confirms it. An unreadable queue
		// proves nothing, so the message stays reported.
		const after = readQueue();
		if (after === null) return { lost, error };
		return { lost: lost.filter((message) => !after.includes(message)), error };
	}

	// A withdrawn message the host gave back and then refused to take again is
	// the user's own input at risk. Report it with its text; a swallowed
	// exception must never be the only trace of a lost sentence.
	function reportLostInput(flow, queue, message, error) {
		const warning = {
			code: "QUEUE_INPUT_RESTORE_FAILED",
			message: String(error?.message ?? error ?? `the host did not take back a withdrawn ${queue} message`),
			flowId: flow.id,
			queue,
			text: messageText(message),
		};
		flow.batch.warnings.push(warning);
		emit(flow.batch, "flow.warning", warning);
	}

	function messageText(message) {
		const content = message?.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return null;
		const parts = content
			.map((part) =>
				typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")
			.filter((part) => part.length > 0);
		return parts.length > 0 ? parts.join("\n") : null;
	}

	// Place one unconsumed copy. The text must end up in exactly one live
	// conversation: drop it when a conversation already shows it or a live flow
	// still holds a queued copy, hand it to a flow that holds none, and carry it
	// upward when this batch has no live recipient left.
	function routeBroadcast(flow, entry) {
		const record = broadcastRecord(entry.broadcastId, entry.text);
		if (broadcastSettled(record)) return;
		const leaves = activeLeaves();
		const heldElsewhere = leaves.some((candidate) =>
			candidate.id !== flow.id && record.copies.get(candidate.id) === "queued");
		if (heldElsewhere) return;
		const targets = leaves.filter((candidate) =>
			candidate.id !== flow.id && record.copies.get(candidate.id) !== "queued");
		if (targets.length > 0) {
			const { delivered } = enqueueBroadcast(targets, entry.text, entry.broadcastId);
			// A partial delivery already shows the text and reported every
			// refusal. Only a total failure leaves no copy anywhere, and that
			// text must travel upward instead of being dropped.
			if (delivered.length > 0) return;
		}
		carryBroadcast(flow.batch, entry);
	}

	// Park text on the nearest batch that has not finalized. A batch that is
	// already done can no longer release its ledger, so walk upward; a done root
	// has adopted its heir already, which makes the owner the right recipient.
	function carryBroadcast(batch, entry) {
		const record = broadcastRecord(entry.broadcastId, entry.text);
		if (broadcastSettled(record)) return;
		let target = batch;
		while (target.done && target.parentBatch) target = target.parentBatch;
		if (target.done) {
			deliverOwnerInput(batch, entry);
			return;
		}
		if (!Array.isArray(target.carryOver)) target.carryOver = [];
		if (!target.carryOver.some((item) => item.broadcastId === entry.broadcastId)) {
			target.carryOver.push({ text: entry.text, broadcastId: entry.broadcastId });
		}
	}

	function rootBatch(batch) {
		let root = batch;
		while (root.parentBatch) root = root.parentBatch;
		return root;
	}

	// Hand text to the owner conversation. Returns the host's thenable when the
	// steer settles later; throws when the owner exposes no steer path at all.
	//
	// `probe` records what the call itself can prove. The host announces queue
	// admission synchronously through `onPromptQueued`, before its promise
	// settles, so admission and settlement are separate facts. A host session
	// that ignores the options argument never fills the probe; its silence is
	// "unknown", never "not queued".
	function injectOwnerInput(batch, text, probe) {
		const owner = batch.owner;
		if (typeof owner?.session?.steer === "function") {
			probe.supported = true;
			return owner.session.steer(text, undefined, {
				onPromptQueued: () => {
					probe.queued = true;
				},
			});
		}
		if (typeof owner?.agent?.steer === "function") {
			return owner.agent.steer({ role: "user", content: text, timestamp: Date.now() });
		}
		throw new Error("the owner exposes no steer()");
	}

	// "shown" is a promise about the conversation, not about the call. Three
	// outcomes must stay distinct:
	//  - admitted: the copy entered the owner's queue. That is terminal even if
	//    the promise rejects afterwards, because steering the text again would
	//    show it twice; the warning below preserves it instead.
	//  - probed and never admitted: the call failed before queueing, so a later
	//    batch may still hand the text over once.
	//  - no admission probe (an owner path without steer options): a rejection
	//    cannot prove the text never queued, so a retry could duplicate it.
	//    Report the unknown outcome with the text and stop.
	function deliverOwnerInput(batch, entry) {
		const root = rootBatch(batch);
		const record = broadcastRecord(entry.broadcastId, entry.text);
		if (broadcastSettled(record) || record.ownerDelivery) return;
		record.ownerDelivery = true;
		const probe = { supported: false, queued: false, definitive: false };
		const land = (ok, detail) => {
			record.ownerDelivery = false;
			if (probe.queued) {
				record.accepted = true;
				if (!ok) {
					undeliveredWarning(
						root,
						"CARRY_OVER_INPUT_ACCEPTED_WITH_ERROR",
						entry,
						detail,
					);
				}
				return;
			}
			if (ok) {
				record.shown = true;
				return;
			}
			if (!probe.supported && !probe.definitive) {
				record.unknown = true;
				undeliveredWarning(root, "CARRY_OVER_INPUT_UNKNOWN", entry, detail);
				return;
			}
			undeliveredWarning(root, "CARRY_OVER_INPUT_FAILED", entry, detail);
		};
		let delivery;
		try {
			delivery = injectOwnerInput(root, entry.text, probe);
		} catch (error) {
			// No steer path exists at all: nothing can have been queued.
			probe.definitive = true;
			land(false, error);
			return;
		}
		if (delivery && typeof delivery.then === "function") {
			delivery.then(
				(value) => land(value !== false),
				(error) => land(false, error),
			);
			return;
		}
		land(delivery !== false);
	}

	// The batch has closed and the heir is the conversation. A broadcast that
	// every flow retired before consuming enters the heir as ordinary input, so
	// the text is both preserved and answered exactly once.
	//
	// A live leaf elsewhere still shows the text better than the owner, so hand
	// it over first. A nested batch must not steer its parent flow's agent: the
	// parent resumes into its own retirement, which retracts queued copies. Its
	// text travels as data instead, through the parent flow's settle while that
	// flow is alive, and through the enclosing batch's ledger when it is not.
	//
	// The owner is steered only by the root batch, after adopt() has replaced
	// the owner's context: an earlier steer is erased by that reset, and the
	// text would be lost with it. Every child batch therefore parks its text
	// upward and lets the root release it once.
	function releaseCarryOver(batch) {
		const pending = Array.isArray(batch.carryOver) ? batch.carryOver.splice(0) : [];
		for (const entry of pending) {
			const record = broadcastRecord(entry.broadcastId, entry.text);
			if (broadcastSettled(record)) continue;
			// The flow that owns this batch retired into it. Its child is done
			// now, so the leaf scan sees it running again until its own
			// finishFlow resumes, but a steer into it would be retracted the
			// moment it resumes retirement. Its text is delivered as data by
			// the parent branch below.
			const leaves = activeLeaves().filter((candidate) => candidate !== batch.parentFlow);
			if (leaves.some((candidate) => record.copies.get(candidate.id) === "queued")) continue;
			const targets = leaves.filter((candidate) => record.copies.get(candidate.id) !== "queued");
			if (targets.length > 0) {
				const { delivered } = enqueueBroadcast(targets, entry.text, entry.broadcastId);
				if (delivered.length > 0) continue;
			}
			const parent = batch.parentFlow;
			if (parent && !isTerminal(parent)) {
				if (!Array.isArray(parent.inheritedCarry)) parent.inheritedCarry = [];
				parent.inheritedCarry.push(entry);
				// finishFlow may already be between awaits, past its own settle
				// point; settle now instead of waiting for a run that will not
				// come around again.
				settlePendingBroadcasts(parent);
				continue;
			}
			// A terminal parent can no longer settle. Its text waits in the
			// enclosing batch, which releases it after that batch has adopted,
			// or hands it to the root once the root itself has adopted.
			if (batch.parentBatch) {
				carryBroadcast(batch.parentBatch, entry);
				continue;
			}
			deliverOwnerInput(batch, entry);
		}
	}

	// -- Scope boundaries -----------------------------------------------------

	function writeAt(anchorId, type, data) {
		if (!anchorId) {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				`cannot write ${type}: no persisted boundary entry`,
			);
		}
		return appendAt(manager, anchorId, () => manager.appendCustomEntry(type, data));
	}

	function appendMessageAt(anchorId, message) {
		if (!anchorId) {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				"cannot write a tool receipt: no persisted batch boundary",
			);
		}
		return appendAt(manager, anchorId, () => manager.appendMessage(message));
	}

	function modelLabel(model) {
		if (typeof model === "string") return model;
		if (!isObject(model)) return String(model ?? "unknown");
		const id = model.id ?? model.name ?? model.model ?? model.spec;
		return typeof id === "string" ? id : String(id ?? "unknown");
	}

	// Every flow sees the same begin tool call but its own tool result. The
	// receipt, not the later prompt, must state what this flow owns, and it
	// keeps the host's call/result pairing by carrying the same toolCallId.
	function receiptMessage(flow) {
		const budget = Object.entries(flow.item.budget)
			.map(([tool, amount]) => `${tool} ${amount}`)
			.join(", ");
		return {
			role: "toolResult",
			toolName: "scope",
			toolCallId: flow.batch.toolCallId,
			isError: false,
			content: [
				{
					type: "text",
					text: [
						`Fission flow ${flow.label} (batch ${flow.batch.id}, index ${flow.index}, stage ${flow.batch.stage}).`,
						`Intent: ${flow.item.intent}`,
						`Budget: ${budget || "none"}. Permission: ${flow.item.permission}. Model: ${modelLabel(flow.model)}.`,
						"This receipt assigns this flow only; sibling receipts assign the other flows.",
					].join("\n"),
				},
			],
			details: {
				fissionReceipt: {
					batchId: flow.batch.id,
					flowId: flow.id,
					index: flow.index,
				},
			},
			timestamp: Date.now(),
		};
	}

	function beginData(flow) {
		return {
			intent: flow.item.intent,
			stage: flow.batch.stage,
			budget: { ...flow.item.budget },
			permission: flow.item.permission,
			batchId: flow.batch.id,
			flow: flow.label,
			flowIndex: flow.index,
			beginToolCallId: flow.batch.toolCallId,
		};
	}

	function endData(flow, status) {
		return {
			intent: flow.item.intent,
			batchId: flow.batch.id,
			flow: flow.label,
			flowIndex: flow.index,
			status,
		};
	}

	function abortedData(flow, reason) {
		return {
			batchId: flow.batch.id,
			flowId: flow.id,
			flow: flow.label,
			label: flow.label,
			reason: String(reason ?? "cancelled"),
		};
	}

	function writeEnd(flow, status) {
		return writeAt(tailOf(flow), "scope.end", endData(flow, status));
	}

	function writeAborted(flow, reason) {
		return writeAt(tailOf(flow), "fission.aborted", abortedData(flow, reason));
	}

	function writeBatchEnd(batch, anchor) {
		return writeAt(tailOf(anchor), "scope.end", {
			batchId: batch.id,
			stage: batch.stage,
			status: batch.status,
			heir: anchor.label,
			flows: batch.flows.map((flow) => flow.label),
		});
	}

	// A batch begin is written at registration, before any flow exists. If the
	// start never completes, close that boundary on the owner's active branch;
	// when the branch has moved elsewhere, attach the end to the begin itself
	// so the journal still records a closed scope.
	function closeUnstartedBatch(batch) {
		if (!batch?.batchBeginId) return null;
		const data = {
			batchId: batch.id,
			stage: batch.stage,
			status: batch.status,
			heir: null,
			flows: batch.flows.map((flow) => flow.label),
		};
		try {
			const leaf = manager.getLeafId();
			let inside = false;
			if (leaf) {
				inside = manager.getBranch(leaf).some((entry) => entry.id === batch.batchBeginId);
			}
			if (inside) {
				const entry = manager.getEntry(leaf);
				if (
					entry?.customType === "scope.end" &&
					entry.data?.batchId === batch.id &&
					Array.isArray(entry.data?.flows)
				) {
					return leaf;
				}
				return manager.appendCustomEntry("scope.end", data);
			}
			return appendAt(manager, batch.batchBeginId, () =>
				manager.appendCustomEntry("scope.end", data),
			);
		} catch {
			return null;
		}
	}

	function closeFlowScope(flow) {
		const scopes = flow.state?.scopes;
		if (!Array.isArray(scopes) || scopes.at(-1)?.id !== flow.scopeId) return;
		try {
			const closed = closeScope(flow.state);
			if (closed?.ok && closed.defers?.length > 0) {
				batchWarning(
					flow.batch,
					"DEFERS_DISCARDED",
					new Error(`${closed.defers.length} undelivered defers were discarded`),
					flow,
				);
			}
		} catch (error) {
			batchWarning(flow.batch, "SCOPE_CLOSE_FAILED", error, flow);
		}
	}

	function closeBatchScope(batch) {
		const state = batch.owner.state;
		if (!Array.isArray(state.scopes) || !batch.scopeId) return;
		const index = state.scopes.findIndex((scope) => scope?.id === batch.scopeId);
		// A stack without the batch scope is already closed. Closing is
		// idempotent, so a retried finalizer may call this twice.
		if (index < 0) return;
		// A scope above the batch scope is a leak: close it and say so instead of
		// leaving the owner permanently one level too deep.
		while (state.scopes.length > index + 1) {
			const open = state.scopes.at(-1);
			batchWarning(
				batch,
				"BATCH_SCOPE_DESCENDANT_OPEN",
				new Error(`scope ${String(open?.id)} is still open inside batch ${batch.id}`),
				null,
			);
			try {
				if (!closeScope(state)?.ok) return;
			} catch (error) {
				batchWarning(batch, "BATCH_SCOPE_CLOSE_FAILED", error, null);
				return;
			}
		}
		if (state.scopes.at(-1)?.id !== batch.scopeId) return;
		try {
			closeScope(state);
		} catch (error) {
			batchWarning(batch, "BATCH_SCOPE_CLOSE_FAILED", error, null);
		}
	}

	// Opened at start, after the control handler has reserved the combined
	// budget on the owner's current scope. It holds the allocation but is never
	// charged: every flow spends from its own state. Skipping this leaves the
	// flow scopes without their structural parent.
	function openBatchScope(batch) {
		if (batch.scopeId) return;
		const opened = beginScope(batch.owner.state, {
			toolCallId: batch.toolCallId,
			intent: batch.intent,
			stage: batch.stage,
			budget: batch.totals,
		});
		if (!opened.ok) {
			throw refusal(opened.code ?? "INVALID_FISSION", opened.reason, { batchId: batch.id });
		}
		batch.scopeId = opened.scope.id;
	}

	// -- Handoff queue --------------------------------------------------------

	function inject(target, messages) {
		if (!Array.isArray(messages) || messages.length === 0) return;
		const state = target.agent?.state;
		if (!Array.isArray(state?.messages)) {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				`receiver ${target.label} lost agent.state.messages`,
			);
		}
		state.messages.push(...messages);
	}

	// A boundary the scheduler wrote is structure the model must see. Convert
	// the journal entries to AgentMessages; a missing entry is not invented.
	function boundaryMessages(...entryIds) {
		const entries = [];
		for (const entryId of entryIds) {
			if (!entryId) continue;
			const entry = manager.getEntry(entryId);
			if (entry) entries.push(entry);
		}
		return handoffMessages(entries);
	}

	function injectBoundaries(flow, entryIds) {
		inject(flow, boundaryMessages(...entryIds));
	}

	async function performCopy(record, target) {
		if (vibeIsActive()) {
			throw refusal(
				FISSION_SCHEDULER_CODES.HANDOFF_VIBE_ACTIVE,
				`handoff ${record.handoffId}: the vibe runtime owns the atomic batch`,
				{ handoffId: record.handoffId },
			);
		}
		const entries = sourceSegment(record);
		const tail = tailOf(target);
		const sourceBase = depthAt(record.from) - 1;
		const targetDepth = depthAt(tail);
		const result = await copyHandoff(manager, {
			tail,
			entries,
			handoffId: record.handoffId,
			sourceBeginId: record.sourceBeginId,
			source: { from: record.from, to: record.to },
			target: { flowId: target.id, label: target.label },
			shift: targetDepth + 1 - sourceBase,
			levelRegex,
			vibeInactive: true,
			durableAtomicWrites: true,
		});
		if (!result || !isNonEmptyString(result.tail) || !Array.isArray(result.entries)) {
			throw refusal(
				FISSION_SCHEDULER_CODES.HANDOFF_FAILED,
				`handoff ${record.handoffId} committed no segment`,
				{ handoffId: record.handoffId },
			);
		}
		return result;
	}

	async function copyRecord(batch, record, target) {
		record.status = "copying";
		try {
			const result = await performCopy(record, target);
			inject(target, result.messages);
			record.status = "done";
			record.copiedTo = target.id;
			record.copiedTail = result.tail;
			emit(batch, "handoff.copied", {
				handoffId: record.handoffId,
				source: record.sourceLabel,
				target: target.label,
				entries: result.entries.length,
			});
		} catch (error) {
			record.status = "failed";
			record.error = error?.message ?? String(error);
			batch.warnings.push({
				code: FISSION_SCHEDULER_CODES.HANDOFF_FAILED,
				handoffId: record.handoffId,
				message: record.error,
			});
			emit(batch, "handoff.failed", {
				handoffId: record.handoffId,
				source: record.sourceLabel,
				target: target.label,
				error: record.error,
			});
		}
	}

	function scheduleFlush(batch) {
		if (batch.done) return batch.flushChain;
		batch.flushChain = batch.flushChain
			.then(async () => {
				if (batch.done) return;
				while (batch.handoffs.length > 0) {
					const head = batch.handoffs[0];
					if (head.status !== "queued") {
						batch.handoffs.shift();
						continue;
					}
					const target = nextOpenFlow(batch, head.sourceIndex);
					if (!target || !copyReady(target)) break;
					await copyRecord(batch, head, target);
					if (head.status === "done" || head.status === "failed") batch.handoffs.shift();
					else break;
				}
			})
			.catch((error) => {
				batchWarning(batch, "HANDOFF_QUEUE_FAILED", error, null);
			});
		return batch.flushChain;
	}

	async function drainToAnchor(batch, anchor) {
		while (batch.handoffs.length > 0) {
			const head = batch.handoffs[0];
			if (head.status !== "queued") {
				batch.handoffs.shift();
				continue;
			}
			await copyRecord(batch, head, anchor);
			batch.handoffs.shift();
		}
	}

	function enqueueHandoff(batch, flow, endId) {
		handoffSeq += 1;
		const record = {
			handoffId: handoffSeq,
			sourceBeginId: flow.beginId,
			sourceLabel: flow.label,
			sourceIndex: flow.index,
			from: flow.beginId,
			to: endId,
			status: "queued",
		};
		batch.handoffs.push(record);
		emit(batch, "handoff.queued", { handoffId: record.handoffId, source: record.sourceLabel });
		void scheduleFlush(batch);
	}

	// -- Adoption and release -------------------------------------------------

	function adopt(batch, heir) {
		const failures = [];
		const owner = batch.owner;
		const heirMessages = heir.agent?.state?.messages;
		if (!Array.isArray(heirMessages)) {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				`heir ${heir.label} exposes no message array`,
			);
		}
		owner.agent.reset();
		const target = owner.agent.state?.messages;
		if (!Array.isArray(target)) {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				"owner agent.state.messages disappeared after reset()",
			);
		}
		target.splice(0, target.length, ...heirMessages);

		const model = heir.model ?? heir.session?.model;
		if (model) {
			if (typeof owner.session?.setModel === "function") {
				try {
					owner.session.setModel(model);
				} catch (error) {
					failures.push({
						code: "OWNER_MODEL_NOT_SWITCHED",
						detail: `setModel() threw: ${error?.message ?? error}`,
					});
				}
			} else if (owner.session?.model !== model) {
				failures.push({
					code: "OWNER_MODEL_NOT_SWITCHED",
					detail: "the owner session exposes no setModel()",
				});
			}
		}
		manager.branch(tailOf(heir));
		return failures;
	}

	function promote(batch, heir) {
		const target = batch.owner.state;
		for (const key of Object.keys(heir.state)) {
			if (SHARED_STATE_FIELDS.has(key)) continue;
			target[key] = heir.state[key];
		}
		target.pinSeen = heir.state.pinSeen;
		try {
			options.onPromote?.(target, heir.state, batch);
			options.persist?.();
		} catch (error) {
			batch.warnings.push({
				code: "PROMOTION_CALLBACK_FAILED",
				message: error?.message ?? String(error),
			});
		}
	}

	function releaseFlow(flow) {
		if (!flow) return;
		if (Array.isArray(flow.unsubscribe)) {
			for (const unsubscribe of flow.unsubscribe.splice(0)) {
				try {
					unsubscribe();
				} catch {
					// Detach is best effort.
				}
			}
		}
		if (!flow.released) {
			flow.released = true;
			recordLimit(
				"FLOW_AGENTS_NOT_DISPOSED",
				"Flow AgentSessions are detached but never disposed: the host dispose path seals the shared SessionManager.",
				{ flowId: flow.id },
			);
		}
		try {
			options.unbindFlow?.(flow.id);
		} catch {
			// Unbind is best effort.
		}
	}

	function batchWarning(batch, code, error, flow) {
		const warning = {
			code,
			message: String(error?.message ?? error),
			flowId: flow?.id ?? null,
		};
		batch.warnings.push(warning);
		emit(batch, "flow.warning", warning);
	}

	// -- Flow completion ------------------------------------------------------

	function pickAnchor(batch) {
		let closed = null;
		let terminal = null;
		for (const flow of batch.flows) {
			if (!isTerminal(flow)) continue;
			if (!terminal || flow.endedOrder > terminal.endedOrder) terminal = flow;
			if (flow.status === "closed" && (!closed || flow.endedOrder > closed.endedOrder)) closed = flow;
		}
		return closed ?? terminal;
	}

	function onFlowTerminal(flow) {
		const batch = flow.batch;
		flow.endedOrder = ++batch.endSeq;
		flow.endedAt = Date.now();
		emit(batch, "flow.ended", { flowId: flow.id, label: flow.label, status: flow.status });
		if (batch.done || batch.finalizing) return;
		if (!batch.flows.every(isTerminal)) return;
		void finalizeBatch(batch, batch.heir ?? pickAnchor(batch));
	}

	async function settleFlowSession(flow) {
		const session = flow.session;
		if (typeof session?.settleInFlightMessagePersistence === "function") {
			try {
				await session.settleInFlightMessagePersistence();
			} catch (error) {
				batchWarning(flow.batch, "FLOW_PERSISTENCE_FAILED", error, flow);
			}
		}
		// Let agent_end maintenance callbacks queued before this turn run before
		// the flow's scope.end is written. This is best effort, not a host
		// quiescence guarantee; see the module header.
		await new Promise((resolve) => {
			if (typeof setImmediate === "function") setImmediate(resolve);
			else setTimeout(resolve, 0);
		});
	}

	async function finishFlow(flow) {
		if (flow.finishPromise) return flow.finishPromise;
		settlePendingBroadcasts(flow);
		const run = async () => {
			if (flow.status === "running" || flow.status === "spawning") flow.status = "ending";
			// The flow's turn is over. Its agent_end has already offered
			// pending nested batches their start; anything registered after this
			// point could never be spawned by this flow and must be refused.
			if (flow.status === "ending" || flow.status === "waiting-heir") {
				flow.nestedSealed = true;
			}
			if (flow.status !== "ending" && flow.status !== "waiting-heir") return;
			await settleFlowSession(flow);
			await scheduleFlush(flow.batch);
			// A nested batch may have released its carry while those awaits were
			// pending. That text arrived after the settle above; without a
			// second pass it stays in flow.inheritedCarry forever.
			settlePendingBroadcasts(flow);
			if (!subtreeClosed(flow)) {
				flow.finishPromise = null;
				return;
			}
			if (flow.status === "waiting-heir") {
				await finalizeBatch(flow.batch, flow);
				return;
			}
			if (!flow.beginId) {
				closeFlowScope(flow);
				flow.status = "crashed";
				onFlowTerminal(flow);
				return;
			}
			closeFlowScope(flow);
			if (flow.cancelReason || flow.endInfo?.aborted === true) {
				const reason = flow.cancelReason ?? flow.endInfo?.reason ?? "cancelled";
				try {
					writeAborted(flow, reason);
				} catch (error) {
					batchWarning(flow.batch, "ABORT_ENTRY_FAILED", error, flow);
				}
				flow.status = "cancelled";
				// A cost cap stops one flow by design, not the batch: siblings
				// keep running and only the batch status reports the cap.
				if (!flow.costCapped) flow.batch.cancelled = true;
				onFlowTerminal(flow);
				return;
			}
			if (flow.error && !flow.retired) {
				try {
					writeAborted(flow, `flow failed: ${flow.error.message ?? flow.error}`);
				} catch (error) {
					batchWarning(flow.batch, "ABORT_ENTRY_FAILED", error, flow);
				}
				flow.status = "crashed";
				onFlowTerminal(flow);
				return;
			}
			const successor = nextOpenFlow(flow.batch, flow.index);
			// A flow with an open nested child cannot receive a segment, but it
			// is still active. Closing this flow and queueing its segment is
			// correct; becoming the heir would finalize the batch while that
			// flow still owns a live subtree and has no flow end.
			const otherActive = flow.batch.flows.some(
				(candidate) => candidate !== flow && !isTerminal(candidate),
			);
			if (successor || otherActive) {
				let endId;
				try {
					endId = writeEnd(flow, "completed");
				} catch (error) {
					batchWarning(flow.batch, "SCOPE_END_FAILED", error, flow);
					flow.status = "crashed";
					onFlowTerminal(flow);
					return;
				}
				flow.endId = endId;
				flow.status = "closed";
				onFlowTerminal(flow);
				enqueueHandoff(flow.batch, flow, endId);
				return;
			}
			flow.status = "waiting-heir";
			flow.batch.heir = flow;
			await finalizeBatch(flow.batch, flow);
		};
		flow.finishPromise = run().catch((error) => {
			flow.finishPromise = null;
			batchWarning(flow.batch, "FLOW_FINISH_FAILED", error, flow);
			flow.status = "crashed";
			onFlowTerminal(flow);
		});
		return flow.finishPromise;
	}

	// -- Finalization ---------------------------------------------------------

	async function finalizeBatch(batch, anchor) {
		if (batch.finalizePromise) return batch.finalizePromise;
		const run = async () => {
			batch.finalizing = true;
			batch.status = "finalizing";
			await batch.flushChain;

			if (anchor && anchor.status === "waiting-heir") {
				await drainToAnchor(batch, anchor);
				// The heir's own flow scope closes here, before promotion, so the
				// batch scope is on top when closeBatchScope() runs. finishFlow()
				// returns early on this path, so this is its only close.
				closeFlowScope(anchor);
				try {
					anchor.endId = writeEnd(anchor, batch.costCapped ? "cost-capped" : "completed");
					anchor.status = "closed";
					anchor.endedOrder = ++batch.endSeq;
					anchor.endedAt = Date.now();
					emit(batch, "flow.ended", {
						flowId: anchor.id,
						label: anchor.label,
						status: anchor.status,
					});
				} catch (error) {
					batchWarning(batch, "HEIR_END_FAILED", error, anchor);
					anchor.status = "crashed";
				}
			} else if (anchor && batch.handoffs.some((record) => record.status === "queued")) {
				for (const record of batch.handoffs) {
					if (record.status !== "queued") continue;
					record.status = "not-copied";
					batch.warnings.push({
						code: FISSION_SCHEDULER_CODES.NO_HEIR,
						handoffId: record.handoffId,
						message: "no closed flow can receive the segment; it remains on its source branch",
					});
				}
				batch.handoffs.length = 0;
			}

			const usable = Boolean(
				anchor && anchor.status === "closed" && !anchor.cancelReason && !anchor.error,
			);
			// A terminal heir still takes over after a crash: the last-ended flow
			// owns the conversation even when its own turn failed. Only a
			// cancelled flow leaves the owner's context untouched.
			const takeover = Boolean(
				anchor &&
				!anchor.cancelReason &&
				(anchor.status === "closed" || anchor.status === "crashed"),
			);
			if (takeover && anchor.status === "crashed" && !anchor.endId) {
				// A crashed flow never wrote its own boundary. Record one now so
				// the adopted context and the journal close at the same depth.
				closeFlowScope(anchor);
				try {
					anchor.endId = writeEnd(anchor, "failed");
				} catch (error) {
					batchWarning(batch, "HEIR_END_FAILED", error, anchor);
				}
			}
			// A crash anywhere in the batch fails the batch summary, even when
			// the surviving anchor is closed and usable. A cost cap is a
			// cancellation, not a crash, so it stays out of this flag.
			const failed = batch.flows.some(
				(flow) =>
					flow.status === "crashed" ||
					(flow.error && !flow.costCapped && !flow.cancelReason),
			);
			if (anchor) {
				batch.status = failed
					? "failed"
					: batch.costCapped
						? "cost-capped"
						: usable
							? "closed"
							: anchor.cancelReason
								? "cancelled"
								: "failed";
				try {
					// The model sees the boundaries the scheduler wrote on the
					// heir's behalf, in journal order: its own scope.end, then the
					// batch scope.end. Adoption splices this context into the owner.
					if (takeover && anchor.endId) injectBoundaries(anchor, [anchor.endId]);
					const batchEndId = writeBatchEnd(batch, anchor);
					if (takeover) injectBoundaries(anchor, [batchEndId]);
				} catch (error) {
					batchWarning(batch, "BATCH_END_FAILED", error, anchor);
					batch.status = "failed";
				}
			} else {
				batch.status = "failed";
				batch.warnings.push({
					code: FISSION_SCHEDULER_CODES.NO_HEIR,
					message: "the batch has no terminal flow to anchor its scope.end",
				});
			}

			if (takeover) {
				try {
					const failures = adopt(batch, anchor);
					for (const failure of failures) {
						recordLimit(failure.code, failure.detail, { flowId: anchor.id });
						batch.limits.push({ ...failure, flowId: anchor.id });
					}
					promote(batch, anchor);
					batch.status = failed
						? "failed"
						: batch.costCapped
							? "cost-capped"
							: failures.length > 0
								? "failed"
								: usable
									? "closed"
									: "failed";
					batch.outcome = failed
						? (failures.length > 0
							? "failed-with-adoption-failure"
							: usable
								? "failed"
								: "failed-with-takeover")
						: usable
							? (failures.length > 0 ? "closed-with-adoption-failure" : "closed")
							: (failures.length > 0 ? "failed-with-adoption-failure" : "failed-with-takeover");
					emit(batch, "batch.adopted", {
						heir: anchor.label,
						limitations: failures.map((failure) => failure.code),
					});
				} catch (error) {
					batch.status = "failed";
					batchWarning(batch, "ADOPTION_FAILED", error, anchor);
				}
			} else if (anchor) {
				try {
					manager.branch(tailOf(anchor));
				} catch (error) {
					batchWarning(batch, "LEAF_BRANCH_FAILED", error, anchor);
				}
			}

			closeBatchScope(batch);
			for (const flow of batch.flows) releaseFlow(flow);

			emit(batch, "batch.closed", { status: batch.status, heir: anchor?.label ?? null });
			resolveBatch(batch, answer(batch));
			releaseCarryOver(batch);
			if (batch.parentFlow) {
				queueMicrotask(() => {
					void finishFlow(batch.parentFlow);
				});
			}
		};
		batch.finalizePromise = run().catch((error) => {
			batch.status = "failed";
			batchWarning(batch, "BATCH_FINALIZE_FAILED", error, null);
			closeBatchScope(batch);
			for (const flow of batch.flows) releaseFlow(flow);
			emit(batch, "batch.closed", { status: batch.status, heir: anchor?.label ?? null });
			resolveBatch(batch, answer(batch));
			releaseCarryOver(batch);
		});
		return batch.finalizePromise;
	}

	// -- Registration ---------------------------------------------------------

	function registerBatch(request = {}) {
		if (disposed) {
			throw refusal(FISSION_SCHEDULER_CODES.SCHEDULER_BUSY, "the scheduler is disposed");
		}
		if (!isObject(request)) {
			throw refusal(FISSION_SCHEDULER_CODES.INVALID_REQUEST, "registerBatch requires an object");
		}
		if (!sharesSharedManager(request.sessionManager, manager)) {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				"registerBatch received a different SessionManager; one scheduler belongs to one shared journal",
			);
		}
		if (!isObject(request.station) || !isObject(request.station.state)) {
			throw refusal(FISSION_SCHEDULER_CODES.UNSUPPORTED, "registerBatch requires station.state");
		}
		// Defense in depth: the station gate already refuses a retired owner,
		// but a direct port caller must not register a batch for it either.
		const retirement = ownerRetirement(request.station, {
			agent: request.identity ?? request.ctx?.agent ?? null,
		});
		if (retirement) {
			throw refusal(FISSION_SCHEDULER_CODES.OWNER_RETIRED, retirement.reason, {
				batchId: retirement.batchId,
			});
		}
		if (!isNonEmptyString(request.toolCallId)) {
			throw refusal(FISSION_SCHEDULER_CODES.INVALID_REQUEST, "toolCallId is required");
		}
		const flows = request.flows ?? request.begin?.fission;
		if (!Array.isArray(flows) || flows.length === 0) {
			throw refusal("INVALID_FISSION", "flows must be a non-empty array");
		}
		const begin = request.begin ?? {
			stage: request.stage,
			elder_report: request.elderReport ?? null,
			fission: flows,
		};
		if (!Array.isArray(begin.fission) || begin.fission.length === 0) {
			begin.fission = flows;
		}
		if (begin.elder_report === undefined) begin.elder_report = request.elderReport ?? null;
		if (begin.stage === undefined) begin.stage = request.stage;

		// Recover a historical half handoff before this batch writes its own
		// begin, while no other live batch is using the journal. Recovery is
		// retirement, not a retry: the source flow did not survive the restart,
		// so the segment cannot be copied again and the handoff is never
		// reported as delivered.
		ensureStartupHandoffRecovery();
		if (options.allowIncompleteHandoffs !== true) {
			if (handoffRecoveryPending) {
				throw refusal(
					FISSION_SCHEDULER_CODES.HANDOFF_RECOVERY_REQUIRED,
					"startup handoff recovery is still running; retry the scope begin",
					{ handoffs: pendingHandoffs().map((item) => item.handoffId) },
				);
			}
			const stale = pendingHandoffs();
			if (stale.length > 0) {
				throw refusal(
					FISSION_SCHEDULER_CODES.HANDOFF_RECOVERY_REQUIRED,
					handoffRecoveryNote ?? "the journal contains an incomplete handoff that startup recovery did not close",
					{ handoffs: stale.map((item) => item.handoffId) },
				);
			}
		}

		const batch = createBatch({ ...request, begin });
		batch.stage = begin.stage;
		const validation = validateFission(batch.owner.state, begin, gateOptions(request));
		if (!validation.ok) {
			throw refusal(validation.code ?? "INVALID_FISSION", validation.reason, { batchId: batch.id });
		}
		const computed = sumBudgets(validation.items);
		if (request.totals && !sameCounts(request.totals, computed)) {
			throw refusal(
				"INVALID_BUDGET",
				"totals do not equal the sum of the flow budgets",
				{ totals: request.totals, computed },
			);
		}
		batch.totals = computed;
		batch.items = validation.items;
		batch.intent = isNonEmptyString(begin.intent)
			? begin.intent
			: `Concurrent fission batch (${batch.items.length} flows)`;

		// Write the batch boundary before the toolResult so the receipt follows
		// it on the same branch. appendAt() restores the leaf it saved, which
		// would place the receipt beside this boundary instead of under it. This
		// write therefore leaves the leaf on the boundary, so the host's next
		// append is its child. On failure the old leaf is restored.
		const anchorId = batch.parentFlow ? tailOf(batch.parentFlow) : manager.getLeafId();
		const savedLeaf = manager.getLeafId();
		try {
			if (anchorId) manager.branch(anchorId);
			else manager.resetLeaf();
			batch.batchBeginId = manager.appendCustomEntry("scope.begin", {
				intent: batch.intent,
				stage: begin.stage,
				budget: { ...computed },
				fissionBatch: true,
				batchId: batch.id,
				flowCount: batch.items.length,
			});
		} catch (error) {
			try {
				if (savedLeaf) manager.branch(savedLeaf);
				else manager.resetLeaf();
			} catch {
				// The boundary write error is the answer.
			}
			throw error;
		}

		batches.push(batch);
		batchesById.set(batch.id, batch);
		if (batch.parentFlow) batch.parentFlow.nested.push(batch);
		emit(batch, "batch.registered", {
			batchBeginId: batch.batchBeginId,
			flows: batch.items.length,
		});
		return {
			ok: true,
			batch,
			batchId: batch.id,
			batchBeginId: batch.batchBeginId,
			ackPending: true,
		};
	}

	// -- Owner retirement and end --------------------------------------------

	function retireOwner(request = {}) {
		const batch = registeredBatchFrom(request);
		if (!batch) {
			throw refusal(FISSION_SCHEDULER_CODES.INVALID_REQUEST, "retireOwner requires a registered batch");
		}
		if (batch.ownerEnded || batch.done) {
			return { ok: true, alreadyEnded: true, abort: false };
		}
		// The extension tool_result event fires inside execute(), before the
		// toolResult is committed. Retirement therefore only cancels the next
		// model call; the host still commits the completed tool's real result.
		//
		// Prefer the owner agent's own abort(). ctx.abort() is a host-context
		// operation that ends the run itself: in print mode (-p) the process
		// exits before the flow sessions finish their prompts.
		// A bare abort looks like a dropped provider stream to the host and is
		// retried. Give this deliberate retirement a reason so it stays terminal.
		// `abort: false` keeps the hook from also calling ctx.abort().
		const agent = batch.owner.agent;
		let abort;
		if (typeof agent?.abort === "function") {
			abort = () => agent.abort("Fission owner retired");
		} else if (typeof request.ctx?.abort === "function") {
			abort = () => request.ctx.abort();
		}
		if (!abort) {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				"neither the owner agent nor ctx exposes abort(); the owner cannot retire",
			);
		}
		batch.ownerRetired = true;
		// Arm the station's gate even when a caller reaches the port directly.
		batch.station?.markOwnerRetired?.({
			batchId: batch.id,
			toolCallId: batch.toolCallId,
			identity: batch.identity ?? request.ctx?.agent ?? null,
		});
		abort();
		emit(batch, "owner.retired", {});
		return { ok: true, abort: false };
	}

	function pendingNested(flow) {
		for (const child of flow.nested) {
			if (!child.ownerEnded && !child.done) void startRegisteredBatch(child);
		}
	}

	async function startRegisteredBatch(batch) {
		if (batch.startPromise) return batch.startPromise;
		batch.startPromise = (async () => {
			try {
				// agent_end can fire before message_end/toolResult persistence
				// settles. Waiting here is what makes the receipt findable.
				if (batch.ackId === undefined || batch.ackId === null) {
					if (typeof batch.owner.session?.settleInFlightMessagePersistence !== "function") {
						throw refusal(
							FISSION_SCHEDULER_CODES.UNSUPPORTED,
							"the owner session lacks settleInFlightMessagePersistence(); the ack may still be unsaved",
						);
					}
					await batch.owner.session.settleInFlightMessagePersistence();
				}
				const ackId = batch.ackId
					?? findToolResultId(manager, batch.toolCallId)
					?? batch.ctx?.ackId
					?? null;
				if (!ackId) {
					throw refusal(
						FISSION_SCHEDULER_CODES.ACK_MISSING,
						`toolResult for ${batch.toolCallId} is not persisted`,
						{ toolCallId: batch.toolCallId },
					);
				}
				batch.ackId = ackId;
				batch.ownerEnded = true;
				if (!manager.getBranch(ackId).some((entry) => entry.id === batch.batchBeginId)) {
					throw refusal(
						FISSION_SCHEDULER_CODES.BATCH_BEGIN_MISSING,
						`batch begin ${batch.batchBeginId} is not an ancestor of ack ${ackId}`,
						{ batchBeginId: batch.batchBeginId, ackId },
					);
				}
				return await startBatchBody(batch);
			} catch (error) {
				batch.status = "failed";
				batch.error = error;
				// Cleanup is best effort and must never replace the start error
				// the caller needs to see.
				try {
					abortFailedBatch(batch, `batch start failed: ${error?.message ?? error}`);
				} catch (cleanupError) {
					batch.warnings.push({
						code: "START_CLEANUP_FAILED",
						message: String(cleanupError?.message ?? cleanupError),
					});
				}
				if (batch.budgetReserved) {
					batch.warnings.push({
						code: "BUDGET_RESERVED_ON_FAILED_START",
						message: "flow budgets were reserved before the failing boundary write; reservations never return",
					});
				}
				try {
					emit(batch, "batch.failed", {
						error: error?.message ?? String(error),
						code: error?.code,
					});
				} catch (emitError) {
					batch.warnings.push({
						code: "BATCH_FAILED_EMIT_FAILED",
						message: String(emitError?.message ?? emitError),
					});
				}
				let result;
				try {
					result = answer(batch);
				} catch (answerError) {
					batch.warnings.push({
						code: "BATCH_ANSWER_FAILED",
						message: String(answerError?.message ?? answerError),
					});
					result = {
						ok: false,
						batchId: batch.id,
						label: batch.label ?? null,
						status: batch.status,
						heir: null,
						flows: [],
					};
				}
				resolveBatch(batch, result);
				if (batch.parentFlow) {
					queueMicrotask(() => {
						void finishFlow(batch.parentFlow);
					});
				}
				return { ok: false, code: error?.code ?? FISSION_SCHEDULER_CODES.UNSUPPORTED, detail: error?.message ?? String(error) };
			}
		})();
		return batch.startPromise;
	}

	// Hooks may pass the station's lightweight pending descriptor
	// ({ batchId, flows: <original request items> }) instead of the runtime
	// batch object. Only an object identity that is the registered batch may be
	// used as one; anything else is resolved by its id, so request items can
	// never be mistaken for runtime flows.
	function registeredBatchFrom(request = {}) {
		const candidate = request.batch;
		if (candidate && batchesById.get(candidate.id) === candidate) return candidate;
		const id = request.batchId ?? candidate?.batchId ?? candidate?.id;
		return typeof id === "string" ? batchesById.get(id) ?? null : null;
	}

	function onOwnerEnd(request = {}) {
		const batch = registeredBatchFrom(request);
		if (!batch) {
			throw refusal(FISSION_SCHEDULER_CODES.INVALID_REQUEST, "onOwnerEnd requires a registered batch");
		}
		if (request.event?.ackId) batch.ackId = request.event.ackId;
		if (request.ctx?.ackId) batch.ackId = request.ctx.ackId;
		batch.ownerEnded = true;
		return startRegisteredBatch(batch);
	}

	// -- Start body -----------------------------------------------------------

	let handoffRecoveryStarted = false;
	let handoffRecoveryPending = false;
	let handoffRecoveryNote = null;
	const handoffRecoveryLog = [];

	function pendingHandoffs() {
		const live = new Set();
		for (const batch of batches) {
			for (const record of batch.handoffs) live.add(record.handoffId);
		}
		return incompleteHandoffs(manager.getEntries())
			.filter((item) => !live.has(item.handoffId));
	}

	function durableRecoverySupported() {
		return typeof manager.getSessionFile === "function" &&
			Boolean(manager.getSessionFile()) &&
			typeof manager.appendEntriesAtomically === "function";
	}

	function recordRecoveryFailure(error, handoffs) {
		handoffRecoveryLog.push({
			at: Date.now(),
			ok: false,
			code: error?.code ?? null,
			message: String(error?.message ?? error),
			handoffs,
		});
		handoffRecoveryNote = `${error?.code ?? "FISSION_RECOVERY_FAILED"}: ${error?.message ?? error}`;
	}

	// Startup recovery is deliberately conservative: it runs before the next
	// batch writes its begin, only with durable writes, only when the vibe
	// runtime is idle, and only when every planned tail is outside the residue.
	// It retires each residue and, when the begin marker recorded the source
	// range, the recipient tail, and the depth shift, rewrites the segment in
	// the same atomic batch. The recipient agent did not survive the restart, so
	// the rewrite can only restore the journal the next session rebuilds from;
	// no live agent.state.messages exists to inject into. A legacy marker that
	// records none of these fields is retired only, and the audit says so.
	function ensureStartupHandoffRecovery() {
		if (handoffRecoveryStarted) return;
		if (options.allowIncompleteHandoffs === true) {
			handoffRecoveryStarted = true;
			return;
		}
		if (vibeIsActive()) return;
		const pending = pendingHandoffs();
		if (pending.length === 0) {
			handoffRecoveryStarted = true;
			return;
		}
		// Never recover underneath a live batch that may still be writing the
		// shared journal. A later begin can retry once the journal is quiet.
		if (batches.some((batch) => !batch.done)) return;
		handoffRecoveryStarted = true;
		const handoffs = pending.map((item) => ({
			handoffId: item.handoffId,
			sourceBeginId: item.sourceBeginId,
			tail: item.tail,
		}));
		if (!durableRecoverySupported()) {
			const error = refusal(
				FISSION_SCHEDULER_CODES.HANDOFF_RECOVERY_REQUIRED,
				"the journal contains an incomplete handoff but this host offers no durable writes",
				{ handoffs: handoffs.map((item) => item.handoffId) },
			);
			recordRecoveryFailure(error, handoffs);
			throw error;
		}
		const plan = planHandoffRecovery(manager.getEntries());
		const plannedIds = new Set(plan.handoffs.map((item) => item.handoffId));
		const safe = plan.recoverable &&
			plan.handoffs.length === pending.length &&
			pending.every((item) => plannedIds.has(item.handoffId)) &&
			plan.handoffs.every((handoff) => handoff.retirable && handoff.retryable);
		if (!safe) {
			const error = refusal(
				FISSION_SCHEDULER_CODES.HANDOFF_RECOVERY_UNSAFE,
				plan.reason ?? plan.retireReason ?? "the handoff tail chain is not provably safe",
				{ handoffs: handoffs.map((item) => item.handoffId) },
			);
			recordRecoveryFailure(error, handoffs);
			throw error;
		}
		const promise = recoverIncompleteHandoffs(manager, {
			durableAtomicWrites: true,
			retire: true,
			vibeInactive: true,
			levelRegex,
		});
		// The chained-node retirement path is synchronous; a lone begin may
		// still be awaiting the host's discard. A new begin must not be written
		// inside the residue while that is in flight.
		handoffRecoveryPending = pendingHandoffs().length > 0;
		promise.then((result) => {
			const copied = result.replay.filter((entry) => entry.status === "copied");
			const retried = result.replay.filter((entry) => entry.status !== "copied");
			handoffRecoveryLog.push({
				at: Date.now(),
				ok: true,
				mode: "retire",
				handoffs,
				retired: result.retired,
				dropped: result.dropped,
				replay: result.replay,
				delivered: copied.length > 0,
				replayable: copied.length > 0,
				rewritten: copied.length,
				// A rewrite restores journal structure only: there is no live
				// recipient agent after a restart, so nothing is injected.
				note: copied.length > 0
					? `rewrote ${copied.length} recorded segment${copied.length === 1 ? "" : "s"} into the journal; the next session reads them from the branch, not from a live agent`
					: retried.length > 0
						? "closed every half handoff; no record held a complete source range, so none was rewritten and the handoffs are not completed"
						: "closed every half handoff",
			});
			handoffRecoveryNote = null;
		}).catch((error) => {
			handoffRecoveryStarted = false;
			recordRecoveryFailure(error, handoffs);
		}).finally(() => {
			handoffRecoveryPending = false;
		});
	}

	function assertNoIncompleteHandoffs() {
		if (options.allowIncompleteHandoffs === true) return;
		const pending = pendingHandoffs();
		if (pending.length > 0) {
			throw refusal(
				FISSION_SCHEDULER_CODES.HANDOFF_RECOVERY_REQUIRED,
				"the journal contains an incomplete handoff; startup recovery did not close it",
				{ handoffs: pending.map((item) => item.handoffId) },
			);
		}
	}

	// The host's AgentSession.prompt() takes text and calls string methods on
	// it (startsWith, trim). A message object fails inside the host, so the
	// intent context travels as text instead of as a custom message.
	function intentText(flow) {
		const budget = Object.entries(flow.item.budget)
			.map(([tool, amount]) => `${tool} ${amount}`)
			.join(", ");
		return [
			`Fission flow ${flow.label} (batch ${flow.batch.id}, index ${flow.index}, stage ${flow.batch.stage}).`,
			`Intent: ${flow.item.intent}`,
			`Budget for this flow: ${budget || "none"}. Permission: ${flow.item.permission}.`,
			"Your flow scope is already open. When your work is complete, call scope({ end: true }); do not call todo. To delegate a nested batch, call scope({ begin: { stage, elder_report, fission: [...] } }); this retires your flow and the nested batch completes it.",
		].join("\n");
	}

	async function startBatchBody(batch) {
		if (disposed) {
			throw refusal(FISSION_SCHEDULER_CODES.SCHEDULER_BUSY, "the scheduler is disposed");
		}
		if (vibeIsActive()) {
			throw refusal(
				FISSION_SCHEDULER_CODES.HANDOFF_VIBE_ACTIVE,
				"the vibe runtime owns the shared journal's atomic batch",
			);
		}
		assertNoIncompleteHandoffs();
		if (!Array.isArray(batch.items) || batch.items.length === 0) {
			throw refusal("INVALID_FISSION", "the batch has no validated flow items");
		}

		const planned = batch.items.map((item, index) => ({
			item,
			index,
			model: resolveModel(item, batch.owner),
			flowId: `f${tokenFor(batch.toolCallId)}x${batch.serial}.${index}`,
			label: `${batch.label}.${index}`,
		}));

		if (typeof options.spawnFlow !== "function") {
			for (const plan of planned) {
				const derived = deriveFissionConfig(sessionOptions(batch, plan));
				if (!derived.ok) {
					throw refusal(
						FISSION_SCHEDULER_CODES.SESSION_UNSUPPORTED,
						`${plan.flowId}: ${derived.detail}`,
						{ flowId: plan.flowId, reason: derived.reason },
					);
				}
			}
		}

		const settled = await Promise.allSettled(planned.map((plan) => spawnFlow(batch, plan)));
		const failed = settled
			.map((result, index) => ({ result, index }))
			.filter(({ result }) => result.status === "rejected");
		if (failed.length > 0) {
			const failures = failed.map(({ result, index }) => ({
				flowId: planned[index].flowId,
				message: result.reason?.message ?? String(result.reason),
			}));
			throw refusal(
				FISSION_SCHEDULER_CODES.SPAWN_FAILED,
				`${failed.length} of ${planned.length} flow sessions could not be created: ${failures.map((failure) => `${failure.flowId}: ${failure.message}`).join("; ")}`,
				{ failures },
			);
		}
		const spawned = settled.map((result) => result.value);

		for (let index = 0; index < spawned.length; index += 1) {
			const { session } = spawned[index];
			if (!session?.prompt && !session?.agent?.prompt) {
				throw refusal(
					FISSION_SCHEDULER_CODES.SESSION_UNSUPPORTED,
					`${planned[index].flowId}: no prompt() is available`,
					{ flowId: planned[index].flowId },
				);
			}
			if (typeof session.getAgentId === "function") {
				const actual = session.getAgentId();
				if (actual !== planned[index].flowId) {
					throw refusal(
						FISSION_SCHEDULER_CODES.SESSION_UNSUPPORTED,
						`${planned[index].flowId}: session agent id is ${String(actual)}; binding uses that string`,
						{ flowId: planned[index].flowId, actual },
					);
				}
			}
		}

		// The control handler reserved the combined budget on the owner's
		// current scope after registration. Open the batch scope now, so every
		// flow state below is derived under it, and never charge it again.
		openBatchScope(batch);

		for (let index = 0; index < planned.length; index += 1) {
			const plan = planned[index];
			const { session } = spawned[index];
			const agent = session.agent;
			if (!isObject(agent)) {
				throw refusal(
					FISSION_SCHEDULER_CODES.SESSION_UNSUPPORTED,
					`${plan.flowId}: the session exposes no agent object`,
					{ flowId: plan.flowId },
				);
			}
			assertAgentShape(agent);

			const state = createFlowState(batch.owner.state);
			const opened = beginScope(state, {
				toolCallId: `${batch.toolCallId}:${index}`,
				intent: plan.item.intent,
				stage: batch.stage,
				budget: plan.item.budget,
			});
			if (!opened.ok) {
				throw refusal(opened.code ?? "INVALID_FISSION", opened.reason, { flowId: plan.flowId });
			}

			const flow = {
				id: plan.flowId,
				label: plan.label,
				index,
				batch,
				item: plan.item,
				permission: plan.item.permission,
				model: plan.model,
				state,
				station: null,
				session,
				agent,
				scopeId: opened.scope.id,
				beginId: null,
				receiptId: null,
				endId: null,
				costCapped: false,
				status: "spawning",
				cancelReason: null,
				error: null,
				endInfo: null,
				retired: false,
				endRequested: false,
				pendingBroadcasts: [],
				inheritedCarry: [],
				released: false,
				nested: [],
				nestedSealed: false,
				unsubscribe: [],
				finishPromise: null,
				startedAt: null,
				endedAt: null,
				endedOrder: 0,
			};
			batch.flows.push(flow);
			flow.station = newFlowStation(batch.station, flow);
			for (const limit of spawned[index].limitations ?? []) {
				recordLimit(limit.code, limit.detail, { flowId: flow.id });
				batch.limits.push({ code: limit.code, detail: limit.detail, flowId: flow.id });
			}

			try {
				const source = subscribeSource(flow);
				flow.unsubscribe.push(source.subscribe((event) => handleFlowEvent(flow, event)));
				flow.unsubscribe.push(attachBridge(flow, source));
			} catch (error) {
				for (const unsubscribe of flow.unsubscribe.splice(0)) {
					try {
						unsubscribe();
					} catch {
						// Detach is best effort.
					}
				}
				throw refusal(
					FISSION_SCHEDULER_CODES.UNSUPPORTED,
					`${plan.flowId}: ${error?.message ?? error}`,
					{ flowId: plan.flowId, cause: error?.message },
				);
			}
		}

		// The original tool call is the batch begin's parent and is shared by
		// every flow. The owner's ack is not: each flow gets its own receipt
		// under the batch begin, so the disk chain is
		// toolCall -> batch begin -> receipt -> flow begin.
		const batchBegin = manager.getEntry(batch.batchBeginId);
		const historyParent = batchBegin?.parentId ?? null;
		const history = historyParent ? handoffMessages(manager.getBranch(historyParent)) : [];
		const batchBoundary = boundaryMessages(batch.batchBeginId);
		for (const flow of batch.flows) {
			flow.receiptId = appendMessageAt(batch.batchBeginId, receiptMessage(flow));
			flow.beginId = writeAt(flow.receiptId, "scope.begin", beginData(flow));
			// The model needs the call and its own result adjacent. The batch
			// boundary is the receipt's disk parent, but injecting it between
			// the call and the result would break the provider's tool protocol,
			// so the boundary follows the receipt in the model context.
			flow.agent.state.messages.push(
				...history,
				...boundaryMessages(flow.receiptId),
				...batchBoundary,
				...boundaryMessages(flow.beginId),
			);
			try {
				options.bindFlow(flow.id, flow.station, flow.permission, {
					batchId: batch.id,
					index: flow.index,
					label: flow.label,
					manager: flow.session.sessionManager ?? manager,
				});
			} catch (error) {
				throw refusal(
					FISSION_SCHEDULER_CODES.UNSUPPORTED,
					`bindFlow failed for ${flow.id}: ${error?.message ?? error}`,
					{ flowId: flow.id },
				);
			}
		}

		for (const flow of batch.flows) {
			if (!flow.cancelReason && batch.cancelled) flow.cancelReason = "cancelled";
			if (flow.cancelReason) {
				closeFlowScope(flow);
				try {
					writeAborted(flow, flow.cancelReason);
				} catch (error) {
					batchWarning(batch, "ABORT_ENTRY_FAILED", error, flow);
				}
				flow.status = "cancelled";
				onFlowTerminal(flow);
				continue;
			}
			const prompt = promptFor(flow);
			flow.status = "running";
			flow.startedAt = Date.now();
			emit(batch, "flow.started", { flowId: flow.id, label: flow.label });
			let pending;
			try {
				pending = prompt(intentText(flow));
			} catch (error) {
				crashFlow(flow, error);
				continue;
			}
			Promise.resolve(pending).then(
				() => settleFlow(flow, { aborted: false }),
				(error) => crashFlow(flow, error),
			);
		}

		if (!batch.done && !batch.finalizing) batch.status = "running";
		batch.budgetReserved = true;
		// The host's agent_end listener cannot await this asynchronous start, so
		// it cannot clear the station's pending descriptor at the right moment.
		// The port clears it here, only after every flow has actually started;
		// clearing earlier would let a second begin slip past the owner gate.
		if (batch.station?.pendingFission?.batchId === batch.id) {
			batch.station.pendingFission = null;
		}
		return {
			ok: true,
			batchId: batch.id,
			label: batch.label,
			flows: batch.flows.map((flow) => ({
				flowId: flow.id,
				label: flow.label,
				index: flow.index,
				beginId: flow.beginId,
			})),
		};
	}

	function abortFailedBatch(batch, reason) {
		const flows = Array.isArray(batch?.flows) ? batch.flows : [];
		const sealed = [];
		for (const flow of flows) {
			if (!flow || typeof flow !== "object") continue;
			if (Array.isArray(flow.unsubscribe)) {
				for (const unsubscribe of flow.unsubscribe.splice(0)) {
					try {
						if (typeof unsubscribe === "function") unsubscribe();
					} catch {
						// Detach is best effort.
					}
				}
			}
			try {
				closeFlowScope(flow);
			} catch {
				// Cleanup must not mask the start error.
			}
			if (flow.beginId && !isTerminal(flow)) {
				try {
					writeAborted(flow, reason);
				} catch {
					// The start error reports the failure.
				}
				if (!flow.endId) {
					try {
						flow.endId = writeEnd(flow, "failed");
						sealed.push(flow);
					} catch {
						// The start error reports the failure.
					}
				}
			}
			if (flow.status === "running" || flow.status === "spawning") flow.status = "crashed";
			try {
				options.unbindFlow?.(flow.id);
			} catch {
				// Unbind is best effort.
			}
		}
		const batchEndId = closeUnstartedBatch(batch);
		for (const flow of sealed) {
			try {
				injectBoundaries(flow, [
					flow.endId,
					...(batchEndId ? [batchEndId] : []),
				]);
			} catch {
				// Context injection is best effort during cleanup.
			}
		}
		try {
			closeBatchScope(batch);
		} catch {
			// Cleanup must not mask the start error.
		}
	}

	// -- Events ---------------------------------------------------------------

	function stopErrorFromMessage(message) {
		const error = new Error(
			typeof message.errorMessage === "string" && message.errorMessage
				? message.errorMessage
				: "the provider reported an error stop reason",
		);
		error.stopReason = "error";
		return error;
	}

	// The host can resolve a turn normally while its assistant message says the
	// turn failed. Read the last assistant message so an error stop reason can
	// never be reported as a completed flow.
	function lastAssistantStopError(flow) {
		const messages = flow.agent?.state?.messages;
		if (!Array.isArray(messages)) return null;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			return message.stopReason === "error" ? stopErrorFromMessage(message) : null;
		}
		return null;
	}

	function settleFlow(flow, info = {}) {
		if (isTerminal(flow)) return flow.finishPromise;
		// A child registered before the parent's turn ended may not have had its
		// own agent_end yet. Start it here so the parent waits on a live child
		// instead of a descriptor nobody will advance.
		pendingNested(flow);
		if (!flow.endRequested && !flow.nested.some((batch) => batch.ownerRetired) && !info.error && !info.aborted && !flow.cancelReason) {
			info = { ...info, error: new Error("flow stopped without calling scope({ end: true })") };
		}
		if (!info.error && info.aborted !== true && !flow.cancelReason) {
			const failure = lastAssistantStopError(flow);
			if (failure) info = { ...info, error: failure };
		}
		const capped = classifyCostCap(flow, info.error);
		flow.endInfo = { ...(flow.endInfo ?? {}), ...info };
		if (info.aborted === true && !flow.cancelReason) {
			flow.cancelReason = info.reason ?? "aborted";
		}
		if (info.error && !capped) flow.error = info.error;
		void finishFlow(flow);
		return flow.finishPromise;
	}

	// A cost cap ends the flow exactly like a cancellation, with a different
	// cause. It must never fall into the crash path, which would report a
	// provider failure and hide that the shared gate is exhausted.
	function classifyCostCap(flow, error) {
		if (!costCapError(error)) return false;
		flow.batch.costCapped = true;
		flow.costCapped = true;
		flow.cancelReason ??= "cost-capped";
		flow.error = null;
		return true;
	}

	function crashFlow(flow, error) {
		if (isTerminal(flow)) return;
		const failure = error instanceof Error ? error : new Error(String(error));
		if (classifyCostCap(flow, failure)) {
			flow.endInfo = { ...(flow.endInfo ?? {}), aborted: true, reason: flow.cancelReason };
			void finishFlow(flow);
			return;
		}
		flow.error = failure;
		flow.endInfo = { ...(flow.endInfo ?? {}), aborted: false, error: flow.error };
		void finishFlow(flow);
	}

	function handleFlowEvent(flow, event) {
		try {
			options.onFlowEvent?.(flow.id, event);
		} catch {
			// An observer must not break the flow.
		}
		if (!isObject(event)) return;
		if (event.type === "agent_end") {
			pendingNested(flow);
			if (flow.endRequested || flow.cancelReason || flow.error || flow.nested.some((batch) => batch.ownerRetired)) {
				settleFlow(flow, { aborted: Boolean(flow.cancelReason) });
			}
			return;
		}
		if (event.type === "message_end") {
			const message = event.message;
			if (
				message?.role === "assistant" &&
				message.stopReason === "error" &&
				!flow.cancelReason &&
				!flow.error
			) {
				const failure = stopErrorFromMessage(message);
				if (!classifyCostCap(flow, failure)) flow.error = failure;
			}
			void scheduleFlush(flow.batch);
			return;
		}
		if (event.type === "error" && !flow.error) {
			const failure = event.error instanceof Error
				? event.error
				: new Error(String(event.error?.message ?? event.message ?? "flow error"));
			if (!classifyCostCap(flow, failure)) flow.error = failure;
		}
	}

	// Cancelling a flow cancels its whole subtree. A retired parent may itself
	// be "ending" while its nested leaves still generate, so the recursion
	// carries the reason through every level instead of stopping at children.
	function cancelDescendants(flow, reason, seen = new Set()) {
		for (const childBatch of flow.nested) {
			childBatch.cancelled = true;
			for (const childFlow of childBatch.flows) {
				if (isTerminal(childFlow) || seen.has(childFlow.id)) continue;
				seen.add(childFlow.id);
				childFlow.cancelReason ??= reason;
				childFlow.batch.cancelled = true;
				if (
					(childFlow.status === "running" || childFlow.status === "spawning") &&
					typeof childFlow.agent?.abort === "function"
				) {
					try {
						settlePendingBroadcasts(childFlow);
						childFlow.agent.abort();
					} catch (error) {
						batchWarning(childFlow.batch, "CANCEL_CASCADE_FAILED", error, childFlow);
					}
				}
				cancelDescendants(childFlow, childFlow.cancelReason ?? reason, seen);
			}
		}
	}

	// -- Public interface -----------------------------------------------------

	function answer(batch) {
		return {
			batchId: batch.id,
			label: batch.label,
			stage: batch.stage,
			status: batch.status,
			outcome: batch.outcome ?? null,
			ackId: batch.ackId ?? null,
			batchBeginId: batch.batchBeginId,
			heir: batch.heir?.label ?? null,
			flows: batch.flows.map((flow) => ({
				flowId: flow.id,
				label: flow.label,
				index: flow.index,
				status: flow.status,
				beginId: flow.beginId ?? null,
				receiptId: flow.receiptId ?? null,
				nested: flow.nested.map((child) => child.id),
			})),
			handoffs: batch.handoffs.map((record) => ({
				handoffId: record.handoffId,
				from: record.from,
				to: record.to,
				source: record.sourceLabel,
				status: record.status,
				copiedTo: record.copiedTo ?? null,
			})),
			warnings: [...batch.warnings],
			limits: batch.limits.map((limit) => limit.code),
		};
	}

	const scheduler = {
		registerBatch,
		retireOwner,
		onOwnerEnd,

		requestFlowEnd(flowId) {
			const flow = findFlow(flowId);
			if (!flow || flow.status !== "running" || flow.endRequested) {
				throw refusal("FISSION_END_UNAVAILABLE", "The flow is not running or has already declared completion.", { flowId });
			}
			if (typeof flow.agent?.abort !== "function") {
				throw refusal(FISSION_SCHEDULER_CODES.UNSUPPORTED, "The flow agent cannot stop after declaring completion.", { flowId });
			}
			flow.endRequested = true;
			if (flow.station?.fissionFlow) flow.station.fissionFlow.endRequested = true;
			return { ok: true };
		},

		retireEndedFlow(flowId) {
			const flow = findFlow(flowId);
			if (!flow?.endRequested || isTerminal(flow)) return;
			settlePendingBroadcasts(flow);
			flow.agent.abort(Symbol.for("pi-agent-core.terminal-tool-result"));
		},

		// Standalone entry point. The control path registers and reserves
		// separately; this convenience method must reserve for itself, because
		// registration no longer does. Pass reserve: false when the caller
		// already charged the owner's scope.
		async start(request = {}) {
			const registered = registerBatch(request);
			if (request.reserve !== false) {
				const split = splitFissionBudget(
					registered.batch.owner.state,
					registered.batch.begin,
					gateOptions(request),
				);
				if (!split.ok) {
					scheduler.cancelBatch(registered.batchId, "reservation refused");
					throw refusal(split.code ?? "INVALID_FISSION", split.reason, {
						batchId: registered.batchId,
					});
				}
			}
			return onOwnerEnd({ batch: registered.batch });
		},

		flowEnded(flowId, info = {}) {
			const flow = findFlow(flowId);
			if (!flow) {
				throw refusal(
					FISSION_SCHEDULER_CODES.FLOW_NOT_FOUND,
					`flow ${flowId} is not known to this scheduler`,
					{ flowId },
				);
			}
			return settleFlow(flow, info);
		},

		cancelFlow(flowId, reason = "cancelled", cancelOptions = {}) {
			const flow = findFlow(flowId);
			if (!flow) {
				throw refusal(
					FISSION_SCHEDULER_CODES.FLOW_NOT_FOUND,
					`flow ${flowId} is not known to this scheduler`,
					{ flowId },
				);
			}
			if (isTerminal(flow)) return { ok: false, code: "ALREADY_TERMINAL", status: flow.status };
			if (typeof flow.agent?.abort !== "function") {
				throw refusal(
					FISSION_SCHEDULER_CODES.UNSUPPORTED,
					`flow ${flowId} exposes no agent.abort()`,
					{ flowId },
				);
			}
			flow.cancelReason = String(reason ?? "cancelled");
			// Cancellation ends the flow's ability to own a new child even
			// before finishFlow observes the aborted turn.
			flow.nestedSealed = true;
			if (cancelOptions.costCap !== true) flow.batch.cancelled = true;
			if (cancelOptions.cascade !== false) {
				cancelDescendants(flow, flow.cancelReason);
			}
			// The abort must not revive a copy this stream can never show:
			// withdraw and reroute it before the host restores its queues.
			settlePendingBroadcasts(flow);
			flow.agent.abort();
			return { ok: true, flowId, reason: flow.cancelReason };
		},

		cancelAll(reason = "cancelled") {
			const results = [];
			const seen = new Set();
			for (const batch of batches) {
				for (const flow of batch.flows) {
					if (seen.has(flow.id) || isTerminal(flow)) continue;
					if (flow.status !== "running" && flow.status !== "spawning") continue;
					seen.add(flow.id);
					try {
						results.push(scheduler.cancelFlow(flow.id, reason));
					} catch (error) {
						results.push({ ok: false, flowId: flow.id, error: error?.message ?? String(error) });
					}
				}
			}
			return results;
		},

		// Undo a registration that will never start. The control handler calls
		// this when its reservation is refused after registration succeeded.
		cancelBatch(batchId, reason = "cancelled") {
			const batch = batchesById.get(batchId);
			if (!batch) {
				return { ok: false, code: FISSION_SCHEDULER_CODES.INVALID_REQUEST, batchId };
			}
			if (batch.done) return { ok: false, code: "ALREADY_TERMINAL", status: batch.status };
			batch.cancelled = true;
			if (batch.flows.length === 0) {
				batch.status = "cancelled";
				closeUnstartedBatch(batch);
				closeBatchScope(batch);
				emit(batch, "batch.closed", { status: batch.status, heir: null });
				resolveBatch(batch, answer(batch));
				return { ok: true, batchId, status: batch.status };
			}
			const results = batch.flows.map((flow) => {
				if (isTerminal(flow)) return { ok: false, flowId: flow.id, status: flow.status };
				try {
					return scheduler.cancelFlow(flow.id, reason);
				} catch (error) {
					return { ok: false, flowId: flow.id, error: error?.message ?? String(error) };
				}
			});
			return { ok: true, batchId, results };
		},

		noteCostCap(flowId, reason = "cost-capped") {
			const flow = findFlow(flowId);
			if (!flow) {
				return { ok: false, code: FISSION_SCHEDULER_CODES.FLOW_NOT_FOUND, flowId };
			}
			flow.batch.costCapped = true;
			flow.costCapped = true;
			return scheduler.cancelFlow(flowId, reason, { costCap: true });
		},

		broadcast(text, broadcastOptions = {}) {
			if (disposed) {
				return { ok: false, code: FISSION_SCHEDULER_CODES.SCHEDULER_BUSY, detail: "the scheduler is disposed" };
			}
			const content = typeof text === "string" ? text : "";
			if (!content.trim()) {
				return { ok: false, code: FISSION_SCHEDULER_CODES.INVALID_REQUEST, detail: "broadcast text is empty" };
			}
			const recipients = activeLeaves();
			if (recipients.length === 0) {
				return {
					ok: false,
					code: FISSION_SCHEDULER_CODES.NO_ACTIVE_FLOW,
					detail: "no running flow; after the batch closes, input belongs to the heir",
				};
			}
			broadcastSeq += 1;
			const broadcastId = isNonEmptyString(broadcastOptions.broadcastId)
				? broadcastOptions.broadcastId
				: `bc${broadcastSeq}`;
			const { labels, delivered, failed } = enqueueBroadcast(recipients, content, broadcastId);
			if (delivered.length === 0) {
				return {
					ok: false,
					code: FISSION_SCHEDULER_CODES.UNSUPPORTED,
					detail: "no flow accepted the broadcast",
					failures: failed,
				};
			}
			return { ok: true, broadcastId, recipients: labels, delivered, failures: failed };
		},

		hasRunningFlows(batchId) {
			const selected = batchId
				? [batchesById.get(batchId)].filter(Boolean)
				: batches;
			return selected.some((batch) =>
				!batch.done &&
				(batch.status === "registered" ||
					batch.status === "starting" ||
					batch.status === "running" ||
					batch.status === "finalizing" ||
					batch.flows.some((flow) => flow.status === "running" || flow.status === "spawning")),
			);
		},

		hasLiveBatches() {
			return batches.some((batch) => !batch.done);
		},

		batchStatus(batchId) {
			const batch = batchesById.get(batchId);
			return batch ? answer(batch) : null;
		},

		status() {
			return { batches: batches.map(answer), limits: [...limits], disposed };
		},

		listFlows() {
			const result = [];
			for (const batch of batches) {
				for (const flow of batch.flows) {
					result.push({
						flowId: flow.id,
						label: flow.label,
						batchId: batch.id,
						index: flow.index,
						status: flow.status,
						beginId: flow.beginId,
						receiptId: flow.receiptId,
						nested: flow.nested.map((child) => child.id),
					});
				}
			}
			return result;
		},

		activeLeaves,

		inspectIncompleteHandoffs() {
			const entries = manager.getEntries();
			const plan = planHandoffRecovery(entries);
			const durable = durableRecoverySupported();
			const byId = new Map(plan.handoffs.map((handoff) => [handoff.handoffId, handoff]));
			return incompleteHandoffs(entries).map((item) => {
				const handoff = byId.get(item.handoffId);
				const tailExists = Boolean(
					handoff && (handoff.tail === null || plan.kept.some((entry) => entry.id === handoff.tail)),
				);
				const safe = durable && plan.recoverable && handoff?.retirable === true && tailExists;
				const reason = safe
					? null
					: !durable
						? "durable writes are unavailable; this host cannot retire residue"
						: !plan.recoverable
							? plan.reason ?? "the plan would leave dangling references"
							: handoff?.retireReason ?? (tailExists ? "the tail chain is not safe to retire" : "the recipient tail is missing");
				return {
					...item,
					tail: handoff?.tail ?? item.tail,
					entries: handoff?.dropIds.length ?? 1,
					discardable: handoff?.discardable ?? false,
					retryable: handoff?.retryable ?? false,
					retirable: handoff?.retirable ?? false,
					replayable: handoff?.replayable ?? false,
					replayReason: handoff?.replayReason ?? null,
					recoverable: safe,
					reason,
					detail: safe
						? handoff?.replayable === true
							? "retirement closes the half segment and rewrites it from the recorded source range in one atomic batch"
							: `retirement closes the half segment without rewriting it: ${handoff?.replayReason ?? "the record has no replayable source range"}`
						: "refused: the scheduler will not start over this residue",
					delivered: false,
				};
			});
		},

		handoffRecoveryLog() {
			return handoffRecoveryLog.map((record) => ({ ...record }));
		},

		waitForBatch(batchId) {
			const batch = batchesById.get(batchId);
			if (!batch) {
				return Promise.reject(refusal(
					FISSION_SCHEDULER_CODES.INVALID_REQUEST,
					`batch ${batchId} is not known to this scheduler`,
					{ batchId },
				));
			}
			return batch.donePromise;
		},

		dispose({ force = false } = {}) {
			if (!force && batches.some((batch) => !batch.done)) {
				throw refusal(
					FISSION_SCHEDULER_CODES.SCHEDULER_BUSY,
					"a batch is still live; pass force to detach it",
				);
			}
			if (force) {
				for (const flow of activeLeaves()) {
					try {
						flow.agent?.abort?.();
					} catch {
						// Forced disposal does not guarantee a clean abort.
					}
				}
			}
			for (const batch of batches) {
				for (const flow of batch.flows) releaseFlow(flow);
			}
			if (ownsBridge) {
				try {
					bridge.dispose?.();
				} catch {
					// The host may have already restored subscribe().
				}
			}
			disposed = true;
		},
	};

	return scheduler;
}
