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
//   * Incomplete handoffs from a crash are refused, never reused.
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

import { beginScope, closeScope, splitFissionBudget, validateFission } from "../scope/accounting.mjs";
import { createFlowState } from "../scope/state.mjs";
import {
	appendAt,
	copyHandoff,
	handoffMessages,
	incompleteHandoffs,
	levelPattern,
} from "../transcript/fission.mjs";
import { installFissionEvents } from "./fission-events.mjs";
import { createFissionSession, deriveFissionConfig } from "./fission-session.mjs";

export const FISSION_SCHEDULER_CODES = Object.freeze({
	UNSUPPORTED: "FISSION_UNSUPPORTED",
	INVALID_REQUEST: "FISSION_INVALID_REQUEST",
	ACK_MISSING: "FISSION_ACK_MISSING",
	BATCH_BEGIN_MISSING: "FISSION_BATCH_BEGIN_MISSING",
	BATCH_SCOPE_MISSING: "FISSION_BATCH_SCOPE_MISSING",
	OWNER_BUSY: "FISSION_OWNER_BUSY",
	SESSION_UNSUPPORTED: "FISSION_SESSION_UNSUPPORTED",
	SPAWN_FAILED: "FISSION_SPAWN_FAILED",
	MODEL_UNRESOLVED: "FISSION_MODEL_UNRESOLVED",
	HANDOFF_RECOVERY_REQUIRED: "FISSION_HANDOFF_RECOVERY_REQUIRED",
	HANDOFF_VIBE_ACTIVE: "FISSION_HANDOFF_VIBE_ACTIVE",
	HANDOFF_FAILED: "FISSION_HANDOFF_FAILED",
	NO_HEIR: "FISSION_NO_HEIR",
	FLOW_NOT_FOUND: "FISSION_FLOW_NOT_FOUND",
	FLOW_NOT_RUNNING: "FISSION_FLOW_NOT_RUNNING",
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
const SHARED_STATE_FIELDS = new Set(["herdMode", "relay", "stageFlags", "pins"]);
const TOOL_RESULT_ROLES = new Set(["toolResult", "tool_result", "tool"]);

function isObject(value) {
	return value !== null && typeof value === "object";
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
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

function findToolResultId(manager, toolCallId) {
	if (!isNonEmptyString(toolCallId)) return null;
	const entries = manager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		const message = entry?.type === "message" ? entry.message : undefined;
		if (!message || !TOOL_RESULT_ROLES.has(message.role)) continue;
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
		batch.resolveDone(result);
	}

	function isTerminal(flow) {
		return TERMINAL.has(flow.status);
	}

	function subtreeClosed(flow) {
		if (!["ending", "closed", "cancelled", "crashed", "waiting-heir"].includes(flow.status)) {
			return false;
		}
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
			for (const child of flow.nested) {
				if (child.done !== true) collectRunning(child, leaves);
			}
			if (leaves.length > 0) {
				target.push(...leaves);
				continue;
			}
			if (flow.status === "running") target.push(flow);
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
		const run = async () => {
			if (flow.status === "running" || flow.status === "spawning") flow.status = "ending";
			if (flow.status !== "ending" && flow.status !== "waiting-heir") return;
			await settleFlowSession(flow);
			await scheduleFlush(flow.batch);
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
				flow.batch.cancelled = true;
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
			if (successor) {
				let endId;
				try {
					endId = writeEnd(flow, "completed");
				} catch (error) {
					batchWarning(flow.batch, "SCOPE_END_FAILED", error, flow);
					flow.status = "crashed";
					onFlowTerminal(flow);
					return;
				}
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
				try {
					writeEnd(anchor, batch.costCapped ? "cost-capped" : "completed");
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
			if (anchor) {
				batch.status = usable
					? (batch.costCapped ? "cost-capped" : "closed")
					: anchor.cancelReason
						? (batch.costCapped ? "cost-capped" : "cancelled")
						: "failed";
				try {
					writeBatchEnd(batch, anchor);
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

			if (usable) {
				try {
					const failures = adopt(batch, anchor);
					for (const failure of failures) {
						recordLimit(failure.code, failure.detail, { flowId: anchor.id });
						batch.limits.push({ ...failure, flowId: anchor.id });
					}
					promote(batch, anchor);
					batch.status = batch.costCapped
						? "cost-capped"
						: failures.length > 0
							? "failed"
							: "closed";
					batch.outcome = failures.length > 0
						? "closed-with-adoption-failure"
						: "closed";
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
		if (request.sessionManager !== manager) {
			throw refusal(
				FISSION_SCHEDULER_CODES.UNSUPPORTED,
				"registerBatch received a different SessionManager; one scheduler belongs to one shared journal",
			);
		}
		if (!isObject(request.station) || !isObject(request.station.state)) {
			throw refusal(FISSION_SCHEDULER_CODES.UNSUPPORTED, "registerBatch requires station.state");
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
		// exits before the flow sessions finish their prompts. Returning
		// `abort: false` tells the hook the scheduler already used the narrow
		// signal, so the hook does not call ctx.abort() on top of it.
		const agent = batch.owner.agent;
		let abort;
		if (typeof agent?.abort === "function") {
			abort = () => agent.abort();
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

	function assertNoIncompleteHandoffs() {
		if (options.allowIncompleteHandoffs === true) return;
		const live = new Set();
		for (const batch of batches) {
			for (const record of batch.handoffs) live.add(record.handoffId);
		}
		const pending = incompleteHandoffs(manager.getEntries())
			.filter((item) => !live.has(item.handoffId));
		if (pending.length > 0) {
			throw refusal(
				FISSION_SCHEDULER_CODES.HANDOFF_RECOVERY_REQUIRED,
				"the journal contains an incomplete handoff; this scheduler cannot remove a half segment",
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
			"Your scope is already open; do not call scope({ begin }).",
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
				status: "spawning",
				cancelReason: null,
				error: null,
				endInfo: null,
				retired: false,
				released: false,
				nested: [],
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

		const prefix = handoffMessages(manager.getBranch(batch.ackId));
		for (const flow of batch.flows) {
			flow.beginId = writeAt(batch.ackId, "scope.begin", beginData(flow));
			flow.agent.state.messages.push(...prefix);
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
			}
			if (flow.status === "running" || flow.status === "spawning") flow.status = "crashed";
			try {
				options.unbindFlow?.(flow.id);
			} catch {
				// Unbind is best effort.
			}
		}
		try {
			closeBatchScope(batch);
		} catch {
			// Cleanup must not mask the start error.
		}
	}

	// -- Events ---------------------------------------------------------------

	function settleFlow(flow, info = {}) {
		if (isTerminal(flow)) return flow.finishPromise;
		flow.endInfo = { ...(flow.endInfo ?? {}), ...info };
		if (info.aborted === true && !flow.cancelReason) {
			flow.cancelReason = info.reason ?? "aborted";
		}
		if (info.error) flow.error = info.error;
		void finishFlow(flow);
		return flow.finishPromise;
	}

	function crashFlow(flow, error) {
		if (isTerminal(flow)) return;
		flow.error = error instanceof Error ? error : new Error(String(error));
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
			settleFlow(flow, { aborted: Boolean(flow.cancelReason) });
			return;
		}
		if (event.type === "message_end") {
			void scheduleFlush(flow.batch);
			return;
		}
		if (event.type === "error" && !flow.error) {
			flow.error = event.error instanceof Error
				? event.error
				: new Error(String(event.error?.message ?? event.message ?? "flow error"));
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
			flow.batch.cancelled = true;
			if (cancelOptions.cascade !== false) {
				cancelDescendants(flow, flow.cancelReason);
			}
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
			return scheduler.cancelFlow(flowId, reason);
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
			const labels = recipients.map((flow) => flow.label);
			const delivered = [];
			const failed = [];
			for (const flow of recipients) {
				if (typeof flow.agent?.steer !== "function") {
					failed.push({ flowId: flow.id, error: "agent.steer() is unavailable" });
					continue;
				}
				try {
					flow.agent.steer({
						role: "custom",
						customType: "fission.broadcast",
						content: `(broadcast to ${recipients.length} flows)\n\n${content}`,
						display: true,
						details: { fissionBroadcast: { broadcastId, recipients: labels } },
						timestamp: Date.now(),
					});
					delivered.push(flow.label);
				} catch (error) {
					failed.push({ flowId: flow.id, error: error?.message ?? String(error) });
				}
			}
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
						nested: flow.nested.map((child) => child.id),
					});
				}
			}
			return result;
		},

		activeLeaves,

		inspectIncompleteHandoffs() {
			return incompleteHandoffs(manager.getEntries()).map((item) => ({
				...item,
				recoverable: false,
				detail: "recovery needs rewriteEntries()/discardEntryDurably(); this scheduler refuses to start over residue",
			}));
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
