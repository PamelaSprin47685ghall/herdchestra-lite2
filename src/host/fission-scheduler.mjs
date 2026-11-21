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
//   * setModel() is asynchronous and is awaited before the owner's leaf moves.
//     A refused or missing switch is reported and the batch ends failed with
//     outcome closed-with-adoption-failure instead of claiming a clean
//     succession.
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

import {
	beginScope,
	closeScope,
	sealClosedParentChildren,
	splitFissionBudget,
	validateFission,
} from "../scope/accounting.mjs";
import { createFlowState, put } from "../scope/state.mjs";
import {
	normalizeToolName,
	roundAmount,
} from "../scope/budget.mjs";
import { beatShares, chargeTool, isFreeCall, scopeOrder } from "../scope/index.mjs";
import {
	findBegin,
	findToolCallIndex,
} from "../transcript/index.mjs";
// Character accounting lives in one place: importing it keeps a flow's
// measured interior identical to the one the station records for ordinary
// scopes, so both kinds of elder are priced by the same ruler.
import { sliceChars } from "../station/fold.mjs";
import {
	appendAt,
	copyHandoff,
	handoffMessages,
	incompleteHandoffs,
	levelPattern,
	mergePins,
	planHandoffRecovery,
	recoverIncompleteHandoffs,
} from "../transcript/fission.mjs";
import { installFissionEvents } from "./fission-events.mjs";
import { rememberSession } from "./capture.mjs";
import { createFissionSession, deriveFissionConfig } from "./fission-session.mjs";
import { isFissionManager } from "./fission-manager.mjs";
import { toolCalls } from "../transcript/messages.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

const RECEIPTS = loadDoc("receipts/scope");
const FLOW_OPEN_NUDGE = loadDoc("errors")["flow-open"];
import { depthAt, findToolResultId, maxHandoffId, tailOf } from "./fission-journal.mjs";
import {
	flowStillHoldsCopy,
	messageText,
	retractQueuedCopies,
} from "./queue-retraction.mjs";

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
// The host uses this reason to classify an operator interrupt (not a retry).
const USER_INTERRUPT = "Interrupted by user";
const COST_CAP_CODES = new Set([
	"COST_CAP",
	"COST_CAP_EXCEEDED",
	"COST_LIMIT_EXCEEDED",
	"MAX_COST_EXCEEDED",
]);
const SHARED_STATE_FIELDS = new Set(["herdMode", "relay", "stageFlags", "pins"]);

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

/**
 * Merge the flow's collapse records into the owner's.
 *
 * A flow state is cloned from the owner's, so it already carries every record
 * the owner had. Copying it back wholesale would replace records the owner
 * holds with the flow's copies, whose `epoch` may have advanced while the flow
 * ran: `applyCollapses` matches records by epoch, so a promoted epoch silently
 * un-collapses history the provider still has cached. The owner's record wins;
 * only scopes the owner never saw are added.
 */
export function mergeCollapses(ownerRecords, heirRecords) {
	const merged = Array.isArray(ownerRecords) ? [...ownerRecords] : [];
	const seen = new Set();
	for (const record of merged) {
		if (typeof record?.scopeId === "string") seen.add(record.scopeId);
	}
	for (const record of Array.isArray(heirRecords) ? heirRecords : []) {
		const id = record?.scopeId;
		if (typeof id === "string") {
			if (seen.has(id)) continue;
			seen.add(id);
		}
		merged.push(record);
	}
	return merged;
}

/**
 * Merge the flow's amend keys into the owner's.
 *
 * An amend is a fact about a beat on the branch that produced it. The owner
 * may have amended before the batch opened and the heir may amend inside its
 * flow; overwriting either set would revive the other side's retracted beats
 * on the next request. Keys are strings, so the union is exact.
 */
export function mergeAmends(ownerAmends, heirAmends) {
	const merged = [];
	const seen = new Set();
	for (const key of [
		...(Array.isArray(ownerAmends) ? ownerAmends : []),
		...(Array.isArray(heirAmends) ? heirAmends : []),
	]) {
		if (typeof key !== "string" || key === "" || seen.has(key)) continue;
		seen.add(key);
		merged.push(key);
	}
	return merged;
}

/**
 * Merge per-model cache records, keeping the position that is still valid.
 *
 * `cachedUntilPos` is a promise about what the provider still holds. The
 * owner's value describes the owner's branch, the flow's describes the flow's.
 * After adoption the conversation continues on the flow's branch, so the entry
 * whose TTL clock is newer describes the cache the next request will actually
 * hit. Taking the minimum unconditionally threw that away: the heir's freshly
 * warmed prefix was truncated back to the owner's older position, and every
 * later decision priced already-cached content as a miss.
 *
 * A stale entry proves nothing, so freshness decides first. With equal clocks
 * the heir's position wins: adoption continues on the heir's branch, and the
 * owner's older minimum would truncate a prefix the heir just warmed.
 */
export function mergeModelCaches(ownerCaches, heirCaches) {
	const merged = {};
	for (const [key, entry] of Object.entries(ownerCaches ?? {})) merged[key] = entry;
	for (const [key, entry] of Object.entries(heirCaches ?? {})) {
		const existing = merged[key];
		if (existing === undefined) {
			merged[key] = entry;
			continue;
		}
		const ownerPos = Number.isInteger(existing?.cachedUntilPos) ? existing.cachedUntilPos : 0;
		const heirPos = Number.isInteger(entry?.cachedUntilPos) ? entry.cachedUntilPos : 0;
		const ownerAt = Number.isFinite(existing?.lastUsedAt) ? existing.lastUsedAt : 0;
		const heirAt = Number.isFinite(entry?.lastUsedAt) ? entry.lastUsedAt : 0;
		if (heirAt !== ownerAt) {
			// The newer writer owns the truth about what the provider holds.
			merged[key] = heirAt > ownerAt ? { ...existing, ...entry } : { ...entry, ...existing };
			continue;
		}
		merged[key] = { ...existing, ...entry, cachedUntilPos: heirPos };
	}
	return merged;
}

/**
 * State fields the flow must never write back to the owner.
 *
 * A flow state is a clone, so every key it carries describes the flow's own
 * branch. Four of them describe the owner's session instead: the shared four
 * below, and the model identity below that. Copying the model identity back
 * makes `from` and `target` at the next scope end derive from the same value,
 * which turns `changingModel` false forever and silently disables the
 * economics fold (`shouldFoldPool` has no other caller).
 */
const OWNER_MODE_KEYS = new Set([
	"baseModelSpec",
	"baseModelKey",
	"previousModelSpec",
	"previousModelKey",
	"modelRecovery",
]);

/**
 * True when a message is the owner's own abort artifact.
 *
 * Retiring the owner used to abort with a reason string, which the host stores
 * as a synthetic assistant message (`stopReason: "aborted"`) plus an error
 * tool result. Those bytes belong to no turn the model should read: keeping
 * them between the scope call and the flow's receipt changes the prefix the
 * flow already cached.
 */
function isRetiredOwnerArtifact(message) {
	if (!message || typeof message !== "object") return false;
	if (
		message.stopReason === "aborted" &&
		message.errorMessage === "Fission owner retired"
	) {
		return true;
	}
	return (
		message.isError === true &&
		typeof message.content === "string" &&
		message.content.includes("Fission owner retired")
	);
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

	/**
	 * Run the turn that answers the user after the batch has been adopted.
	 *
	 * Started synchronously so `agent.state.isStreaming` is already true when
	 * the caller resolves the batch: a dispose barrier or a prompt that saw the
	 * batch close must still wait for this run.
	 *
	 * The host's unexpected-stop detector is configured per session, not per
	 * turn (`features.unexpectedStopDetection`), and the extension cannot reach
	 * that handle through a public export. A session left on its default
	 * "mechanical" mode never classifies a text stop, so this deliberate turn
	 * costs nothing; a session set to "smart" pays one judge call for it.
	 */
	function startPostScopeTurn(batch, anchor) {
		let pending;
		try {
			pending = batch.owner.agent.continue();
		} catch (error) {
			pending = Promise.reject(error);
		}
		return Promise.resolve(pending).then(
			async () => {
				// agent.continue() settles before agent_end maintenance, and the
				// judge runs inside that maintenance; idle covers it.
				try {
					await batch.owner.session?.waitForIdle?.();
				} catch {
					// Idle is a wait, not a result.
				}
			},
			(error) => {
				batchWarning(batch, "POST_BATCH_CONTINUE_FAILED", error, anchor);
			},
		);
	}

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
				{ flowId: plan.flowId, reason: created.reason, cause: created.error },
			);
		}
		// These frames compare session construction. Provider conversion runs
		// later; this check cannot establish a cache hit or a final wire prefix.
		const frames = created.frames ?? null;
		if (frames?.mismatches?.length > 0) {
			recordLimit(
				"FISSION_CONFIG_MISMATCH",
				`flow ${plan.flowId} session configuration differs from the owner: ${frames.mismatches.join(", ")}`,
				{ flowId: plan.flowId, frames },
			);
		}
		if (frames?.unavailable?.length > 0) {
			recordLimit(
				"FISSION_CONFIG_UNAVAILABLE",
				`flow ${plan.flowId} configuration could not be compared: ${frames.unavailable.join(", ")}`,
				{ flowId: plan.flowId, frames },
			);
		}
		return {
			session: created.session,
			limitations: created.limitations ?? [],
			frames,
		};
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
		const flowManager = flow.session?.sessionManager ?? base.manager;
		// A real station forks a view that also owns fresh dispatch caches, a
		// fresh persistence anchor, and a fresh usage ledger. A plain station
		// object (a test double, a host adapter) owns none of those, so its view
		// needs exactly two own fields and inherits the rest.
		//
		// The old fallback copied a fourteen-field list that stopped existing in
		// 2.1.0, when those caches and the anchor moved out of the station. A
		// view built from it looked initialized while holding nothing, and any
		// later edit that trusted it would have shared the owner's caches with a
		// flow. Two fields cannot drift that way.
		if (typeof base.forkForFlow === "function") {
			return base.forkForFlow(flow.state, flowManager);
		}
		const view = Object.create(base);
		view.state = flow.state;
		view.fissionFlow = null;
		view.pendingFission = null;
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

	/** Open-scope depth of one flow state, after its own scope opened. */
	function levelOf(state) {
		return Array.isArray(state?.scopes) ? state.scopes.length : 0;
	}

	/**
	 * The owner level the batch returns to once its own scope closes.
	 *
	 * The batch scope is the innermost scope the owner opened for this batch, so
	 * everything outside it is the parent stack. `level` is the depth the model
	 * lands on, and `intent`/`budget` describe the scope it resumes inside (or
	 * nothing at the top level).
	 */
	function levelAfter(batch) {
		const stack = Array.isArray(batch?.owner?.state?.scopes) ? batch.owner.state.scopes : [];
		const index = stack.findIndex((scope) => scope?.id === batch.scopeId);
		const parents = index >= 0 ? stack.slice(0, index) : stack;
		const parent = parents.at(-1) ?? null;
		const budget = parent
			? Object.entries(parent.remaining ?? {})
				.filter(([tool]) => Object.hasOwn(parent.budget ?? {}, tool))
				.map(([tool, left]) => `${tool} ${left}/${parent.budget[tool]}`)
				.join(", ")
			: "";
		return {
			level: parents.length,
			intent: typeof parent?.intent === "string" ? parent.intent : null,
			budget: budget === "" ? null : budget,
		};
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
			trailingCallIds: [],
			barrierExecuted: [],
			owner,
			parentFlow,
			parentBatch: parentFlow?.batch ?? null,
			flows: [],
			status: "registered",
			heir: null,
			carryOver: [],
			costCapped: false,
			cancelled: false,
			paused: parentFlow?.batch.paused ?? false,
			ownerRetired: false,
			ownerEnded: false,
			batchBeginId: null,
			scopeId: null,
			startPromise: null,
			startBlocked: false,
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
		endPresentationIfIdle({ messages: batch.owner.agent?.state?.messages ?? [] });
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
		if (flow.error || !["spawning", "running", "ending"].includes(flow.status)) return false;
		return flow.nested.every((batch) => batch.done === true);
	}

	function nextOpenFlow(batch, sourceIndex) {
		const flows = batch.flows;
		let index = flows.findIndex((flow) => flow.index === sourceIndex);
		for (let offset = 1; offset < flows.length; offset += 1) {
			index = (index + 1) % flows.length;
			const candidate = flows[index];
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

	function collectRunning(batch, target = [], includePaused = false) {
		if (batch.done || (batch.paused && !includePaused)) return target;
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
				collectRunning(child, leaves, includePaused);
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
			if (!flow.nestedSealed && flow.status === "running" && flow.endRequested !== true && !flow.cancelReason &&
				(includePaused || !flow.blocked)) {
				target.push(flow);
			}
		}
		return target;
	}

	function activeLeaves(includePaused = false) {
		const leaves = [];
		for (const batch of batches) {
			if (batch.parentBatch || batch.done) continue;
			collectRunning(batch, leaves, includePaused);
		}
		return leaves;
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

	function broadcastRecord(broadcastId, text, images) {
		let record = broadcastLedger.get(broadcastId);
		if (!record) {
			record = { text, images, shown: false, copies: new Map(), stuck: new Map() };
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
		const row = broadcastRecord(broadcastId, text);
		const labels = recipients.map((flow) => flow.label);
		const delivered = [];
		const failed = [];
		const deferred = [];
		for (const flow of recipients) {
			const message = {
				role: "custom",
				customType: "fission.broadcast",
				content: row.images?.length
					? [{ type: "text", text: `(broadcast to ${recipients.length} flows)\n\n${text}` }, ...row.images]
					: `(broadcast to ${recipients.length} flows)\n\n${text}`,
				display: true,
				details: { fissionBroadcast: { broadcastId, recipients: labels, text } },
				timestamp: Date.now(),
			};
			const entry = { message, broadcastId, text };
			try {
				// A refused copy must not be overtaken by a later broadcast.
				flushDeferredSteers(flow);
				flow.agent.steer(message);
				rememberBroadcast(flow, message, broadcastId, text);
				delivered.push(flow.label);
			} catch (error) {
				const failure = { flowId: flow.id, error: error?.message ?? String(error) };
				failed.push(failure);
				deferred.push({ flow, entry });
				undeliveredWarning(flow.batch, "BROADCAST_DELIVERY_FAILED", { broadcastId, text }, failure);
			}
		}
		// A totally refused submission stays with the caller. Once any copy
		// was accepted, the scheduler owns the rest; do not ask for a resend.
		if (delivered.length > 0) {
			for (const { flow, entry } of deferred) (flow.resumeSteers ??= []).push(entry);
		}
		bridge.queueChanged?.();
		return { labels, delivered, failed };
	}

	function flushDeferredSteers(flow) {
		const deferred = flow.resumeSteers;
		while (deferred?.length) {
			const entry = deferred[0];
			flow.agent.steer(entry.message);
			rememberBroadcast(flow, entry.message, entry.broadcastId, entry.text);
			deferred.shift();
		}
	}

	function markBroadcastShown(message) {
		const id = message?.details?.fissionBroadcast?.broadcastId;
		const row = broadcastLedger.get(id);
		if (!row || row.shown) return;
		row.shown = true;
		bridge.queueChanged?.();
	}

	function waitForBroadcastPresentation(id) {
		const row = broadcastLedger.get(id);
		if (!row || row.presented || !bridge.presentsBroadcasts) return;
		row.presentation ??= Promise.withResolvers();
		return row.presentation.promise;
	}

	function broadcastPresented(id) {
		const row = broadcastLedger.get(id);
		if (!row) return;
		row.presented = true;
		row.presentation?.resolve();
	}

	function withdrawBroadcast(id) {
		const row = broadcastLedger.get(id);
		if (!row) return;
		broadcastLedger.delete(id);
		row.withdrawn?.resolve();
		row.presentation?.resolve();
	}

	function restoredInput(row) {
		return row.images?.length ? { text: row.text, images: row.images } : { text: row.text };
	}

	function popBroadcast() {
		let candidate;
		for (const [id, row] of broadcastLedger) {
			if (!broadcastSettled(row) && (row.awaiting || row.copies.size)) candidate = [id, row];
		}
		if (!candidate) return;
		const [id, row] = candidate;
		const targets = [];
		for (const flowId of row.copies.keys()) {
			const flow = findFlow(flowId);
			const agent = flow?.agent;
			const matches = (message) => message?.details?.fissionBroadcast?.broadcastId === id;
			const pending = agent?.peekSteeringQueue?.();
			// Like native Alt+Up, never retract an input already in-flight.
			if (!pending?.some(matches) || typeof agent.replaceQueue !== "function" ||
				agent.peekUndeliveredQueuedMessages?.().some(matches)) return;
			targets.push({ flow, agent, remaining: pending.filter((message) => !matches(message)) });
		}
		for (const { flow, agent, remaining } of targets) {
			agent.replaceQueue("steering", remaining);
			flow.pendingBroadcasts = flow.pendingBroadcasts.filter((entry) => entry.broadcastId !== id);
		}
		for (const batch of batches) {
			batch.carryOver = batch.carryOver.filter((entry) => entry.broadcastId !== id);
			for (const flow of batch.flows) {
				flow.inheritedCarry = flow.inheritedCarry.filter((entry) => entry.broadcastId !== id);
				if (flow.resumeSteers?.length) flow.resumeSteers = flow.resumeSteers.filter((entry) => entry.broadcastId !== id);
			}
		}
		withdrawBroadcast(id);
		bridge.queueChanged?.();
		return { ...restoredInput(row), queue: "steering" };
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
		if (flow.resumeSteers?.length) inherited.push(...flow.resumeSteers.splice(0));
		const consumed = pending.length ? consumedBroadcastIds(flow) : null;
		const unlanded = pending.filter((entry) => !isConsumed(flow, entry, consumed));
		const stuck = retractOwnQueuedCopies(flow, unlanded);
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

	function withdrawInterruptInput() {
		const restored = new Set();
		const undelivered = [];
		for (const batch of batches) {
			if (batch.done) continue;
			for (const flow of batch.flows) {
				const pending = flow.pendingBroadcasts.splice(0);
				const consumed = pending.length ? consumedBroadcastIds(flow) : null;
				const unlanded = pending.filter((entry) => !isConsumed(flow, entry, consumed));
				const stuck = retractOwnQueuedCopies(flow, unlanded);
				for (const entry of pending) {
					const row = broadcastRecord(entry.broadcastId, entry.text);
					if (isConsumed(flow, entry, consumed)) row.shown = true;
					if (!stuck.has(entry)) {
						row.copies.delete(flow.id);
						row.stuck.delete(flow.id);
						if (!isConsumed(flow, entry, consumed)) undelivered.push({ flow, entry, row });
					} else {
						row.copies.set(flow.id, "stuck");
						row.stuck.set(flow.id, { flow, entry });
						undeliveredWarning(batch, "BROADCAST_RETRACT_FAILED", entry, flow.id);
					}
					restored.add(entry.broadcastId);
				}
				for (const entry of flow.inheritedCarry.splice(0)) {
					restored.add(entry.broadcastId);
				}
			}
			for (const entry of batch.carryOver.splice(0)) {
				restored.add(entry.broadcastId);
			}
		}
		// Once an operator instruction has landed anywhere, it is no longer a
		// draft. Park the remaining copies out of the native queues until the
		// same leaf resumes, ahead of its new instruction and without an echo.
		// Entries already in the native queue precede any later refused copy.
		for (let i = undelivered.length - 1; i >= 0; i -= 1) {
			const { flow, entry, row } = undelivered[i];
			if (row.shown) (flow.resumeSteers ??= []).unshift(entry);
		}
		for (const batch of batches) {
			if (batch.done) continue;
			for (const flow of batch.flows) {
				if (!flow.resumeSteers?.length) continue;
				flow.resumeSteers = flow.resumeSteers.filter((entry) => {
					if (broadcastLedger.get(entry.broadcastId)?.shown) return true;
					restored.add(entry.broadcastId);
					return false;
				});
			}
		}
		const entries = [];
		// Map insertion order is submission order, independent of which leaf
		// still held a copy at the time of the interrupt.
		for (const [id, row] of broadcastLedger) {
			if ((!row.awaiting && !restored.has(id)) || broadcastSettled(row)) continue;
			entries.push(restoredInput(row));
			withdrawBroadcast(id);
		}
		bridge.queueChanged?.();
		return entries;
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
				if (flowStillHoldsCopy(held.flow.agent, held.entry, isCopy, { withdrew: false, withdrawn: [] })) {
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

	/**
	 * Retract this flow's unqueued broadcast copies.
	 *
	 * The retraction itself lives in ../host/queue-retraction.mjs; this wrapper
	 * supplies the two flow-scoped ports it cannot build itself: the batch
	 * warning sink and the lost-input reporter.
	 */
	function retractOwnQueuedCopies(flow, entries) {
		return retractQueuedCopies(flow, entries, {
			warn: (code, error) => batchWarning(flow.batch, code, error, flow),
			lost: (queue, message, error) => reportLostInput(flow, queue, message, error),
		});
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
	function injectOwnerInput(batch, text, probe, images) {
		const owner = batch.owner;
		if (typeof owner?.session?.steer === "function") {
			probe.supported = true;
			return owner.session.steer(text, images, {
				onPromptQueued: () => {
					probe.queued = true;
				},
			});
		}
		if (typeof owner?.agent?.steer === "function") {
			return owner.agent.steer({ role: "user", content: images?.length ? [{ type: "text", text }, ...images] : text, timestamp: Date.now() });
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
		if (root.adoptionFailed) {
			undeliveredWarning(root, "CARRY_OVER_INPUT_BLOCKED", entry,
				"Owner adoption failed; this input was not sent to the owner.");
			return;
		}
		record.ownerDelivery = true;
		const probe = { supported: false, queued: false, definitive: false };
		const land = (ok, detail) => {
			record.ownerDelivery = false;
			broadcastPresented(entry.broadcastId);
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
			delivery = injectOwnerInput(root, entry.text, probe, record.images);
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
					text: render(RECEIPTS["fission.flow-receipt"], {
						label: flow.label,
						batch: flow.batch.id,
						index: flow.index,
						stage: flow.batch.stage,
						intent: flow.item.intent,
						budget: budget || "none",
						permission: flow.item.permission,
						model: modelLabel(flow.model),
					}),
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
			level: levelOf(flow.state),
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
			level: levelOf(flow.state),
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
		return writeAt(tailOf(manager, flow), "scope.end", endData(flow, status));
	}

	function writeAborted(flow, reason) {
		return writeAt(tailOf(manager, flow), "fission.aborted", abortedData(flow, reason));
	}

	function writeBatchEnd(batch, anchor) {
		const afterClose = levelAfter(batch);
		return writeAt(tailOf(manager, anchor), "scope.end", {
			batchId: batch.id,
			stage: batch.stage,
			status: batch.status,
			heir: anchor.label,
			flows: batch.flows.map((flow) => flow.label),
			failures: [...(batch.spawnFailures ?? []), ...batch.flows.filter((flow) => flow.status === "crashed").map((flow) => ({
				flowId: flow.id,
				label: flow.label,
				error: flow.error?.message ?? null,
			}))],
			level: afterClose.level,
			parentIntent: afterClose.intent,
			parentBudget: afterClose.budget,
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
			failedFlows: batch.spawnFailures,
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

	/**
	 * Record the flow's own scope as a pending elder.
	 *
	 * Fission is the only begin shape the scope tool still accepts, so the
	 * collapse records the economics folds have to be written here: a flow's
	 * `scope({ end: true })` only calls requestFlowEnd and never reaches the
	 * station's end handler that pushes records. Without this the whole
	 * deferred-fold economy ran against an always-empty `state.collapses`.
	 *
	 * The record starts with `report: null` because it is the hot workbench.
	 * The next batch at this level archives it through `begin.elder_report`;
	 * only then does it satisfy `findFoldablePool`.
	 */
	function recordFlowCollapse(flow, scope) {
		const state = flow.state;
		if (!state || !Array.isArray(state.collapses)) return;
		if (!scope || typeof scope.beginToolCallId !== "string") return;
		const endToolCallId =
			(typeof flow.endToolCallId === "string" && flow.endToolCallId) ||
			(typeof scope.endToolCallId === "string" && scope.endToolCallId) ||
			null;
		if (!endToolCallId) return;
		if (state.collapses.some((record) => record?.scopeId === scope.id)) return;
		const messages = Array.isArray(flow.agent?.state?.messages)
			? flow.agent.state.messages
			: [];
		const begin = findBegin(messages, scope.beginToolCallId);
		const endIndex = findToolCallIndex(messages, endToolCallId);
		const interior =
			begin && endIndex > begin.resultIndex
				? messages.slice(begin.resultIndex + 1, endIndex)
				: [];
		// `makeScope` records the boundary and epoch but no parent id, so the
		// level comes from the live stack. `closeScope` has already popped this
		// scope, which makes the new top the level the record belongs to.
		const parentId = state.scopes.at(-1)?.id ?? null;
		state.collapses.push({
			scopeId: scope.id,
			intent: typeof scope.intent === "string" ? scope.intent : null,
			beginToolCallId: scope.beginToolCallId,
			endToolCallId,
			report: null,
			parentId,
			order: scopeOrder(scope),
			boundary: scope.boundary ?? 0,
			epoch: scope.epoch ?? 0,
			collapsed: false,
			sealed: false,
			// No measured usage is available on a flow: its ledger is not
			// wired to the owner's. Character weight is the honest fallback
			// and `measuredModelKey: null` selects it in netRemovableTokens.
			interiorTokens: null,
			measuredModelKey: null,
			baseModelKey: null,
			interiorChars: sliceChars(interior),
			pinTokens: 0,
			pinChars: 0,
			userChars: sliceChars(
				interior.filter((message) => message?.role === "user"),
			),
			paidRentCost: 0,
			baseInputTokens: Number.isFinite(scope.baseInputTokens)
				? scope.baseInputTokens
				: null,
			preBeginInputTokens: Number.isFinite(scope.preBeginInputTokens)
				? scope.preBeginInputTokens
				: null,
			endInputTokens: null,
			endInputTokensPending: false,
			createdAt: Date.now(),
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
			if (closed?.ok) {
				// The closed scope is now an elder at its own level. Seal its
				// children before recording it, so a nested batch that already
				// closed never asks for another report.
				sealClosedParentChildren(flow.state, closed.scope.id);
				recordFlowCollapse(flow, closed.scope);
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
			time: batch.begin?.time,
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
		const tail = tailOf(manager, target);
		const sourceBase = depthAt(manager, record.from) - 1;
		const targetDepth = depthAt(manager, tail);
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
			// A beat the source flow retracted must not come back to life in
			// the recipient: the copied segment is the recipient's prefix, and
			// a revived beat would change the bytes the provider caches.
			amends: record.amends ?? null,
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
		const copying = Promise.withResolvers();
		target.copying = copying.promise;
		try {
			const result = await performCopy(record, target);
			mergePins(batch.station.state.pins, result.pins);
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
		} finally {
			target.copying = null;
			copying.resolve();
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
			// The copied segment must not revive a beat this flow amended
			// away. Snapshot the keys at enqueue time: the flow may close and
			// release its state before the copy actually runs.
			amends: Array.isArray(flow.state?.amends) ? [...flow.state.amends] : [],
			status: "queued",
		};
		batch.handoffs.push(record);
		emit(batch, "handoff.queued", { handoffId: record.handoffId, source: record.sourceLabel });
		void scheduleFlush(batch);
	}

	// -- Adoption and release -------------------------------------------------

	// Prepare the adopted history before changing the owner. Confirm the journal
	// leaf first, then reset and replace the messages in the same synchronous
	// block. A failed branch change must leave the owner's live history intact.
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
		// The heir started from the owner's live prefix and owns the selected
		// journal branch, including any legitimate folds during its run. Do not
		// reconstruct that history from the owner's stale pre-fission view.
		const ownerMessages = Array.isArray(owner.agent.state?.messages)
			? owner.agent.state.messages.slice()
			: [];
		const messages = heirMessages.slice();

		// The owner keeps its own model. The leaf and messages must change
		// together so its next turn attaches to the history it actually sees.
		const savedLeaf = manager.getLeafId();
		let heirTail = null;
		let resetStarted = false;
		try {
			heirTail = tailOf(manager, heir);
			manager.branch(heirTail);
			if (manager.getLeafId() !== heirTail) {
				throw new Error("branch() did not select the heir's tail");
			}
			resetStarted = true;
			owner.agent.reset();
			const state = owner.agent.state;
			if (!state || !Array.isArray(state.messages)) {
				throw new Error("owner agent.state.messages disappeared after reset()");
			}
			state.messages = messages;
		} catch (error) {
			failures.push({
				code: resetStarted ? "OWNER_CONTEXT_NOT_ADOPTED" : "OWNER_LEAF_NOT_MOVED",
				detail: `owner adoption did not commit: ${error?.message ?? error}`,
				tail: heirTail,
			});
			try {
				if (resetStarted) owner.agent.state.messages = ownerMessages;
			} catch (restoreError) {
				failures.push({
					code: "OWNER_CONTEXT_NOT_RESTORED",
					detail: `owner history rollback failed: ${restoreError?.message ?? restoreError}`,
				});
			}
			try {
				if (manager.getLeafId() !== savedLeaf) {
					if (savedLeaf === null) manager.resetLeaf();
					else manager.branch(savedLeaf);
				}
				if (manager.getLeafId() !== savedLeaf) {
					throw new Error("the previous owner leaf was not restored");
				}
			} catch (restoreError) {
				failures.push({
					code: "OWNER_LEAF_NOT_RESTORED",
					detail: `owner leaf rollback failed: ${restoreError?.message ?? restoreError}`,
				});
			}
		}
		return failures;
	}

	function promote(batch, heir, { persist = true } = {}) {
		const target = batch.owner.state;
		// The owner's epoch names its own host boundary history. A flow runs on a
		// private branch and may observe a boundary the owner never saw; importing
		// that number would retire collapse records the owner still needs.
		const ownerEpoch = target.epoch;
		const ownerCollapses = target.collapses;
		const ownerCaches = target.modelCaches;
		const ownerCharges = target.charges;
		const ownerAmends = target.amends;
		for (const key of Object.keys(heir.state)) {
			if (SHARED_STATE_FIELDS.has(key)) continue;
			if (OWNER_MODE_KEYS.has(key)) continue;
			target[key] = heir.state[key];
		}
		target.epoch = ownerEpoch;
		target.collapses = mergeCollapses(ownerCollapses, heir.state.collapses);
		target.amends = mergeAmends(ownerAmends, heir.state.amends);
		target.modelCaches = mergeModelCaches(ownerCaches, heir.state.modelCaches);
		// Flow charges name flow scopes that are already closed; the owner's own
		// charges describe scopes it still holds open.
		target.charges = ownerCharges;
		if (!persist) return;
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
			label: flow?.label ?? null,
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
			if (flow.error) {
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
				injectBoundaries(flow, [endId]);
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

			const needsFlowEnd = anchor?.status === "waiting-heir";
			if (needsFlowEnd) {
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
			} else if (anchor?.status === "closed") {
				await drainToAnchor(batch, anchor);
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
			// A usable heir preserves completed work even if a peer failed.
			const failed = batch.spawnFailures?.length > 0 || batch.flows.some(
				(flow) =>
					flow.status === "crashed" ||
					(flow.error && !flow.costCapped && !flow.cancelReason),
			);
			const terminalStatus = batch.costCapped ? "cost-capped"
				: usable ? (failed ? "partial" : "closed")
				: anchor?.cancelReason ? "cancelled" : "failed";
			if (anchor) {
				batch.status = terminalStatus;
				try {
					// The model sees the boundaries the scheduler wrote on the
					// heir's behalf, in journal order: its own scope.end, then the
					// batch scope.end. Adoption splices this context into the owner.
					if (takeover && anchor.endId && (needsFlowEnd || anchor.status === "crashed")) {
						injectBoundaries(anchor, [anchor.endId]);
					}
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

			const boundaryFailed = batch.status !== terminalStatus;
			let adopted = false;
			if (takeover) {
				batch.status = "finalizing";
				batch.adoptionFailed = true;
				try {
					const failures = adopt(batch, anchor);
					for (const failure of failures) {
						recordLimit(failure.code, failure.detail, { flowId: anchor.id });
						batch.limits.push({ ...failure, flowId: anchor.id });
					}
					if (failures.length > 0) {
						throw refusal("ADOPTION_FAILED", failures.map((failure) => failure.detail).join("; "));
					}
					promote(batch, anchor, { persist: false });
					adopted = true;
					batch.adoptionFailed = false;
					batch.status = boundaryFailed ? "failed" : terminalStatus;
					batch.outcome = !usable ? "failed-with-takeover" : batch.status;
					emit(batch, "batch.adopted", {
						heir: anchor.label,
						limitations: failures.map((failure) => failure.code),
					});
				} catch (error) {
					batch.status = "failed";
					batch.outcome = "failed-with-adoption-failure";
					batchWarning(batch, "ADOPTION_FAILED", error, anchor);
				}
			} else if (anchor) {
				try {
					manager.branch(tailOf(manager, anchor));
				} catch (error) {
					batchWarning(batch, "LEAF_BRANCH_FAILED", error, anchor);
				}
			}

			closeBatchScope(batch);
			if (adopted) {
				try {
					options.onPromote?.(batch.owner.state, anchor.state, batch);
					options.persist?.();
				} catch (error) {
					batchWarning(batch, "PROMOTION_CALLBACK_FAILED", error, anchor);
				}
			}
			for (const flow of batch.flows) releaseFlow(flow);

			emit(batch, "batch.closed", { status: batch.status, heir: anchor?.label ?? null });
			resolveBatch(batch, answer(batch));
			const needsPostScopeTurn =
				!batch.parentBatch &&
				!batch.parentFlow &&
				!batch.paused && !batch.cancelled &&
				adopted &&
				usable &&
				anchor?.endRequested === true &&
				typeof batch.owner.agent?.continue === "function" &&
				batch.owner.agent.state?.isStreaming !== true;
			if (needsPostScopeTurn) {
				void startPostScopeTurn(batch, anchor);
			}
			releaseCarryOver(batch);
			if (batch.parentFlow) {
				queueMicrotask(() => {
					void finishFlow(batch.parentFlow);
				});
			}
		};
		batch.finalizePromise = run().catch((error) => {
			batch.status = "failed";
			batch.outcome = "failed";
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
		// The predicate is asked of the station itself: importing the station's
		// own module here would make the scheduler depend on the layer above it.
		const retirement = typeof request.station.ownerRetirement === "function"
			? request.station.ownerRetirement({
				agent: request.identity ?? request.ctx?.agent ?? null,
			})
			: null;
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
		for (const item of validation.items) {
			if (item.model !== undefined && item.model !== null) {
				resolveModel(item, batch.owner);
			}
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
		const anchorId = batch.parentFlow ? tailOf(manager, batch.parentFlow) : manager.getLeafId();
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
			// The host treats a bare abort as a dropped provider stream and
			// retries it, which writes an `aborted` assistant message into the
			// owner's transcript. That message then sits between the scope call
			// and the flow receipt and breaks the prefix the flow inherits. The
			// terminal symbol is the host's own "this turn ended deliberately"
			// marker, so no artifact is synthesized.
			abort = () =>
				agent.abort(Symbol.for("pi-agent-core.terminal-tool-result"));
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
		if (batch.done) return answer(batch);
		if (batch.startPromise) return batch.startPromise;
		batch.status = "starting";
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
				if (batch.done) return answer(batch);
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
				batch.outcome = "failed";
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
		return render(RECEIPTS["fission.flow-intent"], {
			label: flow.label,
			batch: flow.batch.id,
			index: flow.index,
			stage: flow.batch.stage,
			intent: flow.item.intent,
			budget: budget || "none",
			permission: flow.item.permission,
		});
	}

	/**
	 * Charge the batch's shared first beat to one flow.
	 *
	 * The owner ran those barrier calls once; every flow inherits their results
	 * as if its own first assistant message had produced them. The beat's one
	 * unit is split across its functional tools exactly as `chargeTool` splits
	 * an ordinary message, so a one-flow batch pays what the single-flow path
	 * paid. A flow that budgets nothing for a tool shares the result without
	 * paying, because the tool's share belongs to the flows that asked for it.
	 */
	function chargeSharedFirstBeat(batch, flow, pending) {
		const executed = Array.isArray(pending?.trailingExecuted)
			? pending.trailingExecuted
			: [];
		if (executed.length === 0) return;
		const beatTools = executed.map((entry) => ({
			name: entry.toolName,
			free: isFreeCall(entry.toolName, entry.input),
		}));
		const shares = beatShares(beatTools);
		const scope = flow.state.scopes.at(-1);
		for (const [tool, share] of Object.entries(shares)) {
			if (!(share > 0)) continue;
			const budgeted = Object.hasOwn(scope?.budget ?? {}, tool) ? scope.budget[tool] : 0;
			if (!(budgeted > 0)) continue;
			const charged = chargeTool(flow.state, {
				toolCallId: `${batch.toolCallId}:${flow.index}:first:${tool}`,
				toolName: tool,
				beatTools,
				input: undefined,
			});
			if (!charged.ok) {
				batchWarning(batch, "FIRST_BEAT_CHARGE_FAILED", new Error(charged.reason), flow);
			}
		}
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

		const settled = await Promise.allSettled(planned.map(async (plan) => {
			const prior = batch.preparedSpawns?.[plan.index];
			if (prior?.status === "fulfilled") return prior.value;
			if (prior?.status === "rejected" && !isExternalFailure(prior.reason)) throw prior.reason;
			const spawned = await spawnFlow(batch, plan);
			const { session } = spawned;
			try {
				assertAgentShape(session.agent);
				if (typeof session.agent.continue !== "function" && !promptFor({ session, agent: session.agent })) {
					throw new Error("neither agent.continue() nor prompt() is available");
				}
				if (typeof session.getAgentId === "function" && session.getAgentId() !== plan.flowId) {
					throw new Error("session identity does not match the flow");
				}
				return spawned;
			} catch (error) {
				try {
					await releaseUnstartedSession(session);
				} catch (cleanupError) {
					batchWarning(batch, "START_CLEANUP_FAILED", cleanupError, plan);
				}
				throw error;
			}
		}));
		if (batch.done) {
			await Promise.all(settled.map((result) => result.status === "fulfilled" && releaseUnstartedSession(result.value.session)));
			return answer(batch);
		}
		const failed = settled
			.map((result, index) => ({ result, index }))
			.filter(({ result }) => result.status === "rejected");
		// Retry only failed factories, before writing any branch-local receipt.
		const retryable = failed.filter(({ result }) => isExternalFailure(result.reason));
		if (retryable.length > 0) {
			batch.preparedSpawns = settled;
			batch.startBlocked = true;
			batch.status = "registered";
			for (const { result, index } of retryable) {
				batchWarning(batch, "FLOW_BLOCKED", externalCause(result.reason), {
					id: planned[index].flowId, label: planned[index].label,
				});
			}
			endPresentationIfIdle({ messages: [] });
			return { ok: false, batchId: batch.id, code: "FISSION_START_BLOCKED" };
		}
		batch.preparedSpawns = null;
		batch.spawnFailures = failed.map(({ result, index }) => ({
			flowId: planned[index].flowId,
			label: planned[index].label,
			index,
			status: "crashed",
			error: result.reason?.message ?? String(result.reason),
		}));
		for (const failure of batch.spawnFailures) {
			batchWarning(batch, "FLOW_SPAWN_FAILED", failure.error, { id: failure.flowId, label: failure.label });
		}
		if (failed.length === planned.length) {
			throw refusal(
				FISSION_SCHEDULER_CODES.SPAWN_FAILED,
				`No flow session could be created: ${batch.spawnFailures.map((failure) => `${failure.flowId}: ${failure.error}`).join("; ")}`,
				{ failures: batch.spawnFailures },
			);
		}

		// The control handler reserved the combined budget on the owner's
		// current scope after registration. Open the batch scope now, so every
		// flow state below is derived under it, and never charge it again.
		openBatchScope(batch);

		for (let index = 0; index < planned.length; index += 1) {
			if (settled[index].status !== "fulfilled") continue;
			const plan = planned[index];
			const { session, limitations } = settled[index].value;
			const agent = session.agent;

			const state = createFlowState(batch.owner.state);
			const opened = beginScope(state, {
				toolCallId: `${batch.toolCallId}:${index}`,
				intent: plan.item.intent,
				stage: batch.stage,
				budget: plan.item.budget,
				time: batch.begin?.time,
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
			// A flow's own context only names the manager, and every flow shares
			// one. Capturing the session under these monotonically required keys
			// is what lets `sessionOf(ctx)` return the flow instead of the owner;
			// its manager mapping is keyed per flow proxy, so it stays unambiguous.
			rememberSession(session, manager);
			batch.flows.push(flow);
			flow.station = newFlowStation(batch.station, flow);
			for (const limit of limitations ?? []) {
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
				flow.error = error;
				batchWarning(batch, "FLOW_SPAWN_FAILED", error, flow);
			}
		}

		// The original tool call is the batch begin's parent and is shared by
		// every flow. The owner's ack is not: each flow gets its own receipt
		// under the batch begin, so the disk chain is
		// toolCall -> batch begin -> receipt -> flow begin.
		//
		// The model prefix comes from the owner's live list, not from the
		// journal. A journal rebuild is byte-equal only while every writer kept
		// disk and memory identical; `amend`, a custom wrapper, or a same-beat
		// tool order can differ by one message and the flow's first request then
		// misses the cache the owner just filled. The live list is exactly what
		// the owner's last request sent, minus the bytes no flow may see: the
		// owner's own ack and a retirement artifact.
		// A batch opened at a scope barrier keeps the owner alive until every
		// trailing call has produced its result. Those results are the batch's
		// shared first beat: they ran once, they answer the calls in the opening
		// assistant message, and every flow receives them.
		const pending = batch.station?.pendingFission?.batchId === batch.id
			? batch.station.pendingFission
			: null;
		const trailingCallIds = Array.isArray(pending?.trailingCallIds)
			? pending.trailingCallIds
			: [];
		const trailingIdSet = new Set(trailingCallIds);
		const ownerMessages = Array.isArray(batch.owner.agent?.state?.messages)
			? batch.owner.agent.state.messages
			: [];
		const byCallId = new Map();
		for (const message of ownerMessages) {
			if (message?.role === "toolResult" && trailingIdSet.has(message.toolCallId)) {
				byCallId.set(message.toolCallId, message);
			}
		}
		const trailingResults = [];
		for (const id of trailingCallIds) {
			const message = byCallId.get(id);
			if (message) {
				trailingResults.push(structuredClone(message));
				continue;
			}
			const executed = (pending?.trailingExecuted ?? []).find((entry) => entry.toolCallId === id);
			if (!executed) continue;
			// The host ended the turn before this call's result was persisted.
			// Answer it anyway: an unanswered toolCall in a flow's prefix would
			// make the provider reject the request. This path is recovery-only.
			trailingResults.push({
				role: "toolResult",
				toolCallId: id,
				toolName: executed.toolName,
				content: [{
					type: "text",
					text: "The tool did not complete before the owner retired; no result was persisted.",
				}],
				isError: true,
				timestamp: Date.now(),
			});
		}
		const history =
			ownerMessages.length > 0
				? ownerMessages.filter(
						(message) =>
							!(
								message?.role === "toolResult" &&
								(message.toolCallId === batch.toolCallId || trailingIdSet.has(message.toolCallId))
							) && !isRetiredOwnerArtifact(message),
					)
				: (() => {
						const batchBegin = manager.getEntry(batch.batchBeginId);
						const historyParent = batchBegin?.parentId ?? null;
						return historyParent
							? handoffMessages(manager.getBranch(historyParent))
							: [];
					})();
		const batchBoundary = boundaryMessages(batch.batchBeginId);
		for (const flow of batch.flows) {
			flow.receiptId = appendMessageAt(batch.batchBeginId, receiptMessage(flow));
			// The disk chain is batchBegin -> receipt -> shared results -> flow
			// begin. A later sibling copy starts at `beginId`, so the shared
			// results are never copied twice from another flow.
			let anchor = flow.receiptId;
			for (const result of trailingResults) {
				anchor = appendMessageAt(anchor, structuredClone(result));
			}
			flow.beginId = writeAt(anchor, "scope.begin", beginData(flow));
			// The model needs the call and its own result adjacent. The batch
			// boundary is the receipt's disk parent, but injecting it between
			// the call and the result would break the provider's tool protocol,
			// so the boundary follows the shared results in the model context.
			// The SDK may already have restored the owner branch, including its
			// acknowledgement. Replace that seed; appending would duplicate the
			// entire conversation and make the host rename repeated call IDs.
			flow.agent.state.messages = [
				...history,
				...boundaryMessages(flow.receiptId),
				...trailingResults.map((message) => structuredClone(message)),
				...batchBoundary,
				...boundaryMessages(flow.beginId),
			];
			if (flow.error) continue;
			try {
				options.bindFlow(flow.id, flow.station, flow.permission, {
					batchId: batch.id,
					index: flow.index,
					label: flow.label,
					manager: flow.session.sessionManager ?? manager,
				});
				// continue() skips before_agent_start. Install request preparation
				// now so the first flow request also retains its Skill in the loop.
				const removePreparation = options.prepareFlow?.(flow.session, flow.station);
				if (typeof removePreparation === "function") flow.unsubscribe.push(removePreparation);
				const removePauseGate = flow.agent.addBeforeModelCall?.(() =>
					flow.batch.paused || flow.blocked ? { stop: true } : undefined,
				);
				if (typeof removePauseGate === "function") flow.unsubscribe.push(removePauseGate);
			} catch (error) {
				flow.error = error;
				batchWarning(batch, "FLOW_SPAWN_FAILED", error, flow);
			}
		}

		for (const flow of batch.flows) {
			chargeSharedFirstBeat(batch, flow, pending);
		}

		for (const flow of batch.flows) {
			if (flow.error) {
				void finishFlow(flow);
				continue;
			}
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
			flow.status = "running";
			if (!batch.paused) launchFlow(flow);
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

	async function releaseUnstartedSession(session) {
		const proxy = session?.sessionManager;
		if (!isFissionManager(proxy)) return;
		proxy.seal();
		await proxy.close();
		await proxy.releaseRetainedEntries();
	}

	// -- Events ---------------------------------------------------------------

	function flowMayRun(flow) {
		return !disposed && !flow.batch.paused && !flow.batch.done &&
			!flow.blocked && !flow.cancelReason && !flow.endRequested && flow.status === "running";
	}

	function launchFlow(flow, fallbackText = intentText(flow)) {
		if (!flowMayRun(flow)) return;
		if (flow.startedAt === null) {
			flow.startedAt = Date.now();
			emit(flow.batch, "flow.started", { flowId: flow.id, label: flow.label });
		}
		const epoch = (flow.turnEpoch ?? 0) + 1;
		flow.turnEpoch = epoch;
		bridge.beginWork?.();
		void runFlowTurn(flow, epoch, fallbackText).catch((error) => {
			if (flow.turnEpoch === epoch) crashFlow(flow, error);
		});
	}

	async function runFlowTurn(flow, epoch, fallbackText) {
		if (flow.copying) {
			await flow.copying;
			if (flow.turnEpoch !== epoch) return;
			if (flow.cancelReason) {
				settleFlow(flow, { aborted: true });
				return;
			}
			if (!flowMayRun(flow)) return;
		}
		const before = flow.session.getLastAssistantMessage?.() ?? lastAssistant(flow);
		const previousCap = flow.session.costCapRefusal;
		flow.turnStartAssistant = before;
		try {
			if (typeof flow.agent?.continue === "function") await flow.agent.continue();
			else await promptFor(flow)(fallbackText);
		} catch (error) {
			if (flow.turnEpoch !== epoch) return;
			if (flow.cancelReason) {
				settleFlow(flow, { aborted: true });
				return;
			}
			if (!flowMayRun(flow) || !blockExternalFailure(flow, error)) throw error;
			return;
		}
		if (flow.turnEpoch !== epoch) return;
		if (flowMayRun(flow) && !flow.nested.some((batch) => batch.ownerRetired)) {
			// Core continue() resolves before AgentSession's persistence/recovery.
			await flow.session.waitForIdle?.();
			if (flow.turnEpoch !== epoch) return;
			const cap = flow.session.costCapRefusal;
			if (flowMayRun(flow) && cap && cap !== previousCap) {
				flow.batch.costCapped = true;
				flow.costCapped = true;
				settleFlow(flow, { aborted: true, reason: cap.message ?? "cost-capped" });
				return;
			}
			const last = flow.session.getLastAssistantMessage?.() ?? lastAssistant(flow);
			if (flowMayRun(flow) && last !== before && last?.stopReason === "aborted" && last.errorMessage === USER_INTERRUPT) {
				// A native tool dialog can abort its own session rather than the
				// owner. An operator interrupt still owns the whole batch.
				scheduler.pauseAll();
				return;
			}
			// A provider that rejects the tool name, the tool choice, or the
			// argument schema has not failed the flow: the model can correct the
			// call and continue. This must run before the external-failure test,
			// because a 429 body can carry the same words.
			if (flowMayRun(flow) && last !== before && last?.stopReason === "error" &&
				recoverModelError(flow, stopErrorFromMessage(last))) return;
			if (flowMayRun(flow) && last !== before && last?.stopReason === "error" &&
				blockExternalFailure(flow, stopErrorFromMessage(last))) return;
			if (flowMayRun(flow) && last !== before && last?.stopReason === "error") {
				settleFlow(flow, { error: stopErrorFromMessage(last) });
				return;
			}
			if (flowMayRun(flow) && flow.error && blockExternalFailure(flow, flow.error)) return;
			if (flowMayRun(flow) && last !== before && last?.stopReason === "stop" && !flow.error) {
				// The cap counts consecutive recoverable errors, not lifetime ones.
				flow.modelErrorRetries = 0;
				const text = FLOW_OPEN_NUDGE;
				if (typeof flow.agent.continue === "function") {
					flow.agent.steer({ role: "developer", content: [{ type: "text", text }], attribution: "agent", timestamp: Date.now() });
				}
				launchFlow(flow, text);
				return;
			}
		}
		settleFlow(flow, { aborted: false });
	}

	function blockExternalFailure(flow, error) {
		if (!isExternalFailure(error)) return false;
		flow.blocked = true;
		flow.error = error;
		batchWarning(flow.batch, "FLOW_BLOCKED", error, flow);
		endPresentationIfIdle({ messages: flow.agent.state.messages });
		return true;
	}

	function externalCause(error) {
		return error?.details?.cause ?? error?.cause ?? error;
	}

	function isExternalFailure(error) {
		const cause = externalCause(error);
		if (costCapError(error) || costCapError(cause)) return false;
		const status = Number(cause?.errorStatus ?? cause?.status ?? cause?.statusCode ?? /^([45]\d\d)\b/.exec(cause?.message ?? "")?.[1]);
		return [401, 402, 403, 404, 408, 409, 429].includes(status) ||
			(status >= 500 && status < 600) || /^(?:ECONN|EAI_|ETIMEDOUT|ENET|EHOST|UND_ERR_)/.test(cause?.code ?? "") ||
			/\b(?:api key|credentials?|authentication|unauthorized|rate.limit|quota|timed out|network|connection|overloaded|service unavailable)\b/i.test(cause?.message ?? "");
	}

	const MODEL_ERROR_MAX_RETRIES = 3;

	function isModelRecoverableError(error) {
		const cause = externalCause(error);
		if (costCapError(error) || costCapError(cause)) return false;
		const text = String(cause?.message ?? error?.message ?? "");
		return /outside the tool choice|tool_choice|invalid.?tool.?call|invalid arguments|tool schema|schema validation|unknown tool|malformed.+tool|function.+not found/i.test(text);
	}

	// Steer the model back on its own error instead of settling the flow. The
	// count lives on the flow, so a sibling flow's failures never consume this
	// one's retries.
	function recoverModelError(flow, error) {
		if (!isModelRecoverableError(error)) return false;
		const attempts = (flow.modelErrorRetries ?? 0) + 1;
		if (attempts > MODEL_ERROR_MAX_RETRIES) return false;
		flow.modelErrorRetries = attempts;
		const text = `The previous model/tool call failed with a recoverable error: ${error.message}\nFix the tool name, tool choice, or argument schema and continue.`;
		if (typeof flow.agent?.steer === "function") {
			flow.agent.steer({
				role: "developer",
				content: [{ type: "text", text }],
				attribution: "agent",
				timestamp: Date.now(),
			});
		}
		launchFlow(flow, text);
		return true;
	}

	function stopErrorFromMessage(message) {
		const error = new Error(
			typeof message.errorMessage === "string" && message.errorMessage
				? message.errorMessage
				: "the provider reported an error stop reason",
		);
		error.stopReason = "error";
		error.errorStatus = message.errorStatus;
		return error;
	}

	// The host can resolve a turn normally while its assistant message says the
	// turn failed. Read the last assistant message so an error stop reason can
	// never be reported as a completed flow.
	function lastAssistant(flow) {
		const messages = flow.agent?.state?.messages;
		if (!Array.isArray(messages)) return null;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			return message;
		}
		return null;
	}

	function settleFlow(flow, info = {}) {
		if (isTerminal(flow) || ((flow.batch.paused || flow.blocked) && !flow.endRequested &&
			!flow.cancelReason && !info.error && !flow.nested.some((child) => child.ownerRetired))) return flow.finishPromise;
		// A child registered before the parent's turn ended may not have had its
		// own agent_end yet. Start it here so the parent waits on a live child
		// instead of a descriptor nobody will advance.
		pendingNested(flow);
		if (!info.error && info.aborted !== true && !flow.cancelReason) {
			const last = lastAssistant(flow);
			if (last !== flow.turnStartAssistant && last?.stopReason === "error") {
				info = { ...info, error: stopErrorFromMessage(last) };
			}
		}
		if (!flow.endRequested && !flow.nested.some((batch) => batch.ownerRetired) && !info.error && !info.aborted && !flow.cancelReason && !flow.error) {
			info = { ...info, error: new Error("Flow ended without a completion receipt or a normal model stop") };
		}
		const capped = classifyCostCap(flow, info.error);
		flow.endInfo = { ...(flow.endInfo ?? {}), ...info };
		if (info.aborted === true && !flow.cancelReason) {
			flow.cancelReason = info.reason ?? "aborted";
		}
		if (info.error && !capped && flow.error !== info.error) {
			flow.error = info.error;
			batchWarning(flow.batch, "FLOW_FAILED", info.error, flow);
		}
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
		batchWarning(flow.batch, "FLOW_FAILED", failure, flow);
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
		if (event.type === "message_start" || event.type === "message_end") markBroadcastShown(event.message);
		if (event.type === "agent_end") {
			pendingNested(flow);
			if (flow.endRequested || flow.cancelReason || flow.nested.some((batch) => batch.ownerRetired)) {
				settleFlow(flow, { aborted: Boolean(flow.cancelReason) });
			}
			return;
		}
		if (event.type === "message_end") {
			void scheduleFlush(flow.batch);
			return;
		}
		if (event.type === "error" && !flow.error) {
			if (flow.batch.paused && !flow.cancelReason) return;
			const failure = event.error instanceof Error
				? event.error
				: new Error(String(event.error?.message ?? event.message ?? "flow error"));
			if (!classifyCostCap(flow, failure)) flow.error = failure;
		}
	}

	async function interruptFlow(flow, reason = USER_INTERRUPT) {
		try {
			if (typeof flow.session.abort === "function") await flow.session.abort({ reason });
			else flow.agent.abort(reason);
			await flow.session.waitForIdle?.();
		} catch (error) {
			batchWarning(flow.batch, "FLOW_INTERRUPT_FAILED", error, flow);
			if (!flow.cancelReason) crashFlow(flow, error);
		}
	}

	function pauseAll() {
		const targets = batches.filter((batch) => !batch.done && !batch.paused);
		for (const batch of targets) batch.paused = true;
		const restored = withdrawInterruptInput();
		const followUp = [];
		const pending = [];
		for (const batch of targets) {
			for (const flow of batch.flows) {
				if (flow.status !== "running" || flow.endRequested || flow.cancelReason) continue;
				try {
					const input = flow.session.clearQueue?.({ forInterrupt: true });
					if (input) {
						restored.push(...input.steering);
						followUp.push(...input.followUp);
					}
				} catch (error) {
					batchWarning(batch, "FLOW_QUEUE_RETRACT_FAILED", error, flow);
				}
				// A retired parent still has to settle into its nested batch.
				if (!flow.nested.some((child) => child.ownerRetired)) flow.turnEpoch = (flow.turnEpoch ?? 0) + 1;
				flow.interrupt = interruptFlow(flow);
				pending.push(flow.interrupt);
			}
		}
		if (targets.length > 0 || restored.length > 0) {
			endPresentationIfIdle({ messages: [], interrupted: true });
		}
		return { restored, followUp, settled: Promise.all(pending) };
	}

	async function resumeBroadcast(text, broadcastOptions) {
		const previous = queuedAdmission;
		const gate = Promise.withResolvers();
		const admission = previous ? Promise.all([previous, gate.promise]) : gate.promise;
		queuedAdmission = admission;
		void admission.then(() => {
			if (queuedAdmission === admission) queuedAdmission = null;
		});
		try {
			return await admitBroadcast(text, broadcastOptions, previous);
		} finally {
			gate.resolve();
		}
	}

	async function admitBroadcast(text, broadcastOptions, previous) {
		const paused = batches.filter(isSuspendedBatch);
		const starting = batches.filter((batch) => !batch.done && batch.status === "starting");
		const generation = interruptGeneration;
		const id = broadcastOptions.broadcastId ?? `bc${++broadcastSeq}`;
		const row = broadcastRecord(id, text, broadcastOptions.images);
		row.awaiting = true;
		row.withdrawn = Promise.withResolvers();
		bridge.queueChanged?.();
		for (const batch of paused) {
			if (!batch.startBlocked) continue;
			batch.paused = true; // Hold the first provider request for the resume input.
			batch.startBlocked = false;
			batch.startPromise = null;
			void startRegisteredBatch(batch);
		}
		await Promise.race([row.withdrawn.promise, Promise.all([
			previous,
			...starting.map((batch) => batch.startPromise),
			...paused.flatMap((batch) => batch.flows.length === 0
				? [batch.startPromise] : batch.flows.map((flow) => flow.interrupt)),
		])]);
		if (!broadcastLedger.has(id)) return { ok: true, broadcastId: id, delivered: [], failures: [] };
		row.awaiting = false;
		row.withdrawn = null;
		if (generation !== interruptGeneration) {
			broadcastLedger.delete(id);
			bridge.queueChanged?.();
			return { ok: false, detail: "The broadcast was interrupted before it could be delivered." };
		}
		const recipients = activeLeaves(true);
		if (!recipients.length && paused.some((batch) => batch.startBlocked)) {
			broadcastLedger.delete(id);
			bridge.queueChanged?.();
			return { ok: false, detail: "The batch is still blocked. Fix the reported issue and send another message to resume." };
		}
		const resumed = recipients.filter((flow) => flow.batch.paused || flow.blocked);
		const outcome = broadcastTo(recipients, text, { ...broadcastOptions, broadcastId: id });
		if (!outcome.ok) return outcome;
		for (const batch of paused) batch.paused = false;
		for (const flow of resumed) {
			if (!outcome.delivered.includes(flow.label)) {
				flow.blocked = true;
				continue;
			}
			flow.blocked = false;
			flow.error = null;
			flow.interrupt = null;
			launchFlow(flow, text);
		}
		return { ...outcome, resumed: resumed.length > 0 };
	}

	let interruptGeneration = 0;
	let queuedAdmission = null;

	function isSuspendedBatch(batch) {
		return !batch.done && (batch.paused || batch.startBlocked || batch.flows.some((flow) => flow.blocked && !isTerminal(flow)));
	}

	function hasActiveWork() {
		return !disposed && batches.some((batch) => !batch.done && !batch.paused && !batch.startBlocked &&
			(batch.flows.length === 0 || batch.finalizing || batch.flows.some((flow) =>
				!isTerminal(flow) && !flow.blocked && !flow.nested.some((child) => !child.done))));
	}

	function endPresentationIfIdle(event) {
		if (!hasActiveWork()) {
			bridge.endWork?.(event);
			releasePendingPresentations();
		}
	}

	function releasePendingPresentations() {
		for (const row of broadcastLedger.values()) row.presentation?.resolve();
	}

	function broadcastTo(recipients, text, options) {
		if (!recipients.length) {
			if (options.broadcastId) broadcastLedger.delete(options.broadcastId);
			bridge.queueChanged?.();
			return { ok: false, code: FISSION_SCHEDULER_CODES.NO_ACTIVE_FLOW, detail: "no running flow; after the batch closes, input belongs to the heir" };
		}
		const id = options.broadcastId ?? `bc${++broadcastSeq}`;
		broadcastRecord(id, text, options.images);
		const { labels, delivered, failed } = enqueueBroadcast(recipients, text, id);
		if (!delivered.length) {
			broadcastLedger.delete(id);
			return { ok: false, code: FISSION_SCHEDULER_CODES.UNSUPPORTED, detail: "no flow accepted the broadcast", failures: failed };
		}
		return { ok: true, broadcastId: id, recipients: labels, delivered, failures: failed };
	}

	// Cancelling a flow cancels its whole subtree. A retired parent may itself
	// be "ending" while its nested leaves still generate, so the recursion
	// carries the reason through every level instead of stopping at children.
	function cancelDescendants(flow, reason, seen = new Set()) {
		for (const childBatch of flow.nested) {
			if (childBatch.done) continue;
			childBatch.cancelled = true;
			if (childBatch.flows.length === 0) {
				scheduler.cancelBatch(childBatch.id, reason);
				continue;
			}
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
						abortCancelledFlow(childFlow);
					} catch (error) {
						batchWarning(childFlow.batch, "CANCEL_CASCADE_FAILED", error, childFlow);
					}
				}
				cancelDescendants(childFlow, childFlow.cancelReason ?? reason, seen);
			}
		}
	}

	function abortCancelledFlow(flow) {
		if (flow.batch.paused || flow.blocked || typeof flow.session.abort === "function") {
			flow.interrupt ??= interruptFlow(flow, flow.cancelReason);
			void flow.interrupt.then(() => settleFlow(flow, { aborted: true }));
		} else {
			flow.agent.abort(flow.cancelReason);
		}
	}

	// -- Public interface -----------------------------------------------------

	function answer(batch) {
		return {
			batchId: batch.id,
			label: batch.label,
			stage: batch.stage,
			status: batch.status,
			paused: batch.paused,
			outcome: batch.outcome ?? null,
			ackId: batch.ackId ?? null,
			batchBeginId: batch.batchBeginId,
			heir: batch.heir?.label ?? null,
			flows: [...batch.flows.map((flow) => ({
				flowId: flow.id,
				label: flow.label,
				index: flow.index,
				status: flow.status,
				error: flow.error?.message ?? null,
				beginId: flow.beginId ?? null,
				receiptId: flow.receiptId ?? null,
				nested: flow.nested.map((child) => child.id),
			})), ...(batch.spawnFailures ?? [])].sort((a, b) => a.index - b.index),
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
		pauseAll() {
			interruptGeneration += 1;
			return pauseAll();
		},
		interruptEpoch: () => interruptGeneration,
		hasActiveWork,
		hasPausedWork: () => batches.some(isSuspendedBatch),
		canBroadcast: () => batches.some((batch) => !batch.done && (batch.startBlocked || batch.status === "starting")),
		inputLeaves: () => activeLeaves(true),
		queuedBroadcasts: () => [...broadcastLedger.values()]
			.filter((row) => !broadcastSettled(row) && (row.awaiting || row.copies.size > 0)).map((row) => row.text),
		popBroadcast,
		broadcastPresented,
		waitForBroadcastPresentation,
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
			if (flow.cancelReason && flow.interrupt) return { ok: true, flowId, reason: flow.cancelReason };
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
			abortCancelledFlow(flow);
			return { ok: true, flowId, reason: flow.cancelReason };
		},

		cancelAll(reason = "cancelled") {
			interruptGeneration += 1;
			// Whole-session teardown must not carry an undelivered steer to
			// the owner that is about to switch or close its conversation.
			withdrawInterruptInput();
			const results = [];
			for (const batch of batches) {
				if (batch.done) continue;
				batch.cancelled = true;
				if (batch.flows.length === 0) {
					results.push(scheduler.cancelBatch(batch.id, reason));
					continue;
				}
				for (const flow of batch.flows) {
					if (flow.status !== "running" && flow.status !== "spawning") continue;
					try {
						results.push(scheduler.cancelFlow(flow.id, reason, { cascade: false }));
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
				if (batch.startBlocked) {
					for (const result of batch.preparedSpawns ?? []) {
						if (result.status === "fulfilled") {
							void releaseUnstartedSession(result.value.session).catch((error) => batchWarning(batch, "START_CLEANUP_FAILED", error));
						}
					}
					batch.preparedSpawns = null;
				}
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
			if (queuedAdmission || scheduler.hasPausedWork() || scheduler.canBroadcast()) return resumeBroadcast(content, broadcastOptions);
			return broadcastTo(activeLeaves(), content, broadcastOptions);
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
