/**
 * Fork branch session factory.
 *
 * One fork branch runs in its own AgentSession. This module builds that
 * session from an existing session, in the way the host `/tan` controller
 * does. It reports every condition that it cannot rebuild faithfully instead
 * of guessing.
 *
 * The caller supplies the shared objects:
 *   - sessionManager: the batch's one SessionManager, so the flow never adds a
 *     second writer;
 *   - asyncJobManager: the session tree's job manager, so the flow never
 *     resolves a process-global manager;
 *   - costGate: `owner.costGate` by reference, so the dollar cap stays one
 *     gate for the whole tree.
 *
 * The factory installs no event bridge, extension hook, or session_init entry.
 * The caller owns event forwarding. Tool approval is the one UI seam it does
 * claim: when the host result exposes setToolUIContext() and the owner context
 * was registered, the flow's tools receive a labelled delegate of that
 * context, so an approval prompt names the requesting flow. Without either
 * fact the flow keeps the host's headless tool UI and the limitation list says
 * so. A generation rate is never installed implicitly: relayTokenRate() is an
 * explicit export for the caller that owns the sampling edge.
 *
 * The caller must also never call `dispose()` on a flow session: the host
 * dispose path seals and closes the shared SessionManager, which stops every
 * other flow from writing.
 */

import {
	canProxyBranchManager,
	createBranchManager,
	sharedManagerOf,
	retainBranchManager,
} from "./branch-manager.mjs";

function isClosedSnapshotBranch(branch) {
	if (!Array.isArray(branch) || branch.length === 0) return true;
	let index = branch.length - 1;
	while (index >= 0 && branch[index]?.type === "message" && branch[index]?.message?.herdSkill === true) {
		index -= 1;
	}
	if (index < 0) return true;
	const tail = branch[index];
	if (
		tail?.type === "message" &&
		tail.message?.role === "assistant" &&
		Array.isArray(tail.message.content) &&
		tail.message.content.some((block) => block?.type === "toolCall")
	) {
		return false;
	}
	return true;
}
import { createBranchAgentRegistry } from "./branch-agents.mjs";
import { createHash } from "node:crypto";

function frameDigest(value) {
	try {
		const text = JSON.stringify(value);
		if (typeof text !== "string") return null;
		return createHash("sha256").update(text).digest("hex");
	} catch {
		return null;
	}
}

/**
 * Compare the inputs used to construct a flow with the owner's inputs.
 *
 * This checks tool names, the supplied system prompt, and the selected cache
 * key. It does not observe tool schemas or any later host/provider conversion.
 * Use request-frames.mjs at the send boundary to compare provider requests.
 *
 * An empty mismatch list does not mean that the provider payloads match.
 * Unreadable or unserializable inputs are reported separately and leave ok false.
 */
export function compareBranchFrames(owner, config) {
	const ownerPrompt =
		read(read(read(owner, "agent"), "state"), "systemPrompt") ??
		read(owner, "systemPrompt");
	const ownerTools = call(owner, "getEnabledToolNames");
	const ownerMounted = mountedToolView(owner);
	const ownerKey =
		read(read(owner, "agent"), "promptCacheKey") ??
		config?.taskPromptCacheKey ??
		read(owner, "sessionId") ??
		null;
	const flowKey =
		config?.providerPromptCacheKey ??
		config?.taskPromptCacheKey ??
		config?.providerSessionId ??
		null;
	const frames = {
		tools: {
			owner: Array.isArray(ownerTools) && Array.isArray(ownerMounted)
				? frameDigest([ownerTools, ownerMounted]) : null,
			flow: Array.isArray(config?.toolNames) && Array.isArray(config?.mountedToolNames)
				? frameDigest([config.toolNames, config.mountedToolNames]) : null,
		},
		systemPrompt: {
			owner: frameDigest(ownerPrompt),
			flow: frameDigest(config?.systemPrompt),
		},
		promptCacheKey: {
			owner: frameDigest(ownerKey),
			flow: frameDigest(flowKey),
		},
	};
	const unavailable = Object.keys(frames).filter(
		(key) => frames[key].owner === null || frames[key].flow === null,
	);
	const mismatches = Object.keys(frames).filter(
		(key) => !unavailable.includes(key) && frames[key].owner !== frames[key].flow,
	);
	return {
		layer: "construction",
		frames,
		mismatches,
		unavailable,
		ok: unavailable.length === 0 && mismatches.length === 0,
	};
}

/**
 * Compare an owner's prepared AgentMessage prefix with the flow's copy.
 *
 * The caller supplies the prefix after removing owner-only artifacts. This
 * check runs before provider conversion and does not establish a cache hit.
 */
function compareMessagePrefix(ownerPrefix, flowMessages) {
	const valid = Array.isArray(ownerPrefix) && Array.isArray(flowMessages);
	const owner = Array.isArray(ownerPrefix) ? ownerPrefix : [];
	const flow = Array.isArray(flowMessages) ? flowMessages : [];
	const slice = flow.slice(0, owner.length);
	const sameLength = slice.length === owner.length;
	const ownerHash = frameDigest(owner);
	const flowHash = frameDigest(slice);
	const available = valid && ownerHash !== null && flowHash !== null;
	return {
		layer: "agent-messages",
		frame: { owner: ownerHash, flow: flowHash, length: owner.length },
		available,
		ok: available && sameLength && ownerHash === flowHash,
	};
}

import {
	BRANCH_SESSION_LIMITS,
	BRANCH_SESSION_REASONS,
	DETAIL,
	FLOW_ID_PATTERN,
	LIMIT_DETAIL,
} from "./branch/refusals.mjs";

// The codes a caller branches on and the sentence a human reads travel together,
// and they are data: no session, no host, no read. `branch/refusals.mjs` owns
// them; the two vocabularies callers already import stay exported from here.
export { BRANCH_SESSION_LIMITS, BRANCH_SESSION_REASONS };

import { isNonEmptyString, read } from "./object-read.mjs";

/**
 * The owner's mounted tool names, newest host API first.
 *
 * omp 19.1 replaced xd:// devices with bash tool commands and renamed
 * getMountedXdevToolNames() to getMountedToolCommandNames(). Both return the
 * names presented as tool commands. Reading only the old name makes the whole
 * tool view unreadable on 19.1 and refuses every fork with NO_TOOL_VIEW.
 */
function mountedToolView(owner) {
	const current = call(owner, "getMountedToolCommandNames");
	if (Array.isArray(current)) return current;
	const legacy = call(owner, "getMountedXdevToolNames");
	return Array.isArray(legacy) ? legacy : null;
}

/** Call a zero-argument method and return null when it is absent or throws. */
function call(holder, name) {
	const fn = read(holder, name);
	if (typeof fn !== "function") return null;
	try {
		const value = fn.call(holder);
		return value === undefined ? null : value;
	} catch {
		return null;
	}
}

function limitation(code) {
	return { code, detail: LIMIT_DETAIL[code] };
}

function refusal(reason, extra = {}) {
	return { ok: false, reason, detail: DETAIL[reason], ...extra };
}

// One session-scoped lease per shared manager. It is never released: the owner
// session owns the manager's lifetime, so a flow's dispose drops only that
// flow's lease and can never seal the journal out from under its siblings.
const sessionLeases = new WeakSet();

function retainSessionLease(shared) {
	if (sessionLeases.has(shared)) return;
	retainBranchManager(shared);
	sessionLeases.add(shared);
}

// The owner's interface context, keyed by the owner session. The activation
// layer registers it before any batch opens; a flow factory cannot read the
// host's private tool UI store, and it must not invent one.
const ownerUIContexts = new WeakMap();

/**
 * Register the interface context of one owner session.
 *
 * Returns false when either value cannot serve as a context. A later flow
 * factory for this session then reports OWNER_UI_ABSENT instead of installing
 * a half-built approval path.
 */
export function registerOwnerUI(ownerSession, ui) {
	if (!ownerSession || (typeof ownerSession !== "object" && typeof ownerSession !== "function")) {
		return false;
	}
	if (!ui || typeof ui !== "object") return false;
	ownerUIContexts.set(ownerSession, ui);
	return true;
}

/** Prompt methods whose first argument is plain text shown to the user. */
const LABELLED_PROMPT_METHODS = new Set(["select", "confirm", "input", "editor"]);

function labelText(text, label) {
	if (typeof text !== "string" || text === "") return `Fork branch ${label}`;
	return `Fork branch ${label}\n${text}`;
}

/**
 * Wrap one interface context so every prompt names the requesting flow.
 *
 * The approval dialog receives `full` and `compact` prompts; both get the
 * label line, while the answer is returned unchanged. Other methods stay on
 * the child's headless context: a notice or editor mutation is not approval.
 * Returns null when there is no root UI.
 */
export function labelledUIContext(ui, label, headless = {}) {
	if (!ui || typeof ui !== "object") return null;
	const name = typeof label === "string" && label !== "" ? label : "unnamed";
	return new Proxy(ui, {
		get(target, property) {
			if (property !== "approve" && !LABELLED_PROMPT_METHODS.has(property)) {
				const local = headless?.[property];
				return typeof local === "function" ? local.bind(headless) : local;
			}
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (property === "approve") {
				return (prompt, options) => {
					if (!prompt || typeof prompt !== "object") return value.call(target, prompt, options);
					const decorated = { ...prompt };
					if (typeof decorated.full === "string") decorated.full = labelText(decorated.full, name);
					if (typeof decorated.compact === "string") decorated.compact = labelText(decorated.compact, name);
					return value.call(target, decorated, options);
				};
			}
			return (first, ...rest) => {
				const shown = typeof first === "string" ? labelText(first, name) : first;
				return value.call(target, shown, ...rest);
			};
		},
	});
}

/**
 * Forward one flow's generation rate to the meter the status bar reads.
 *
 * A flow owns its own AgentSession and therefore its own TokenRateMeter, while
 * the interface reads the owner session's meter. `seed` is the meter's public
 * way to publish a reading from another source: seeding `rate` over one second
 * makes the owner's `rate()` return exactly that value. The caller samples at
 * its own event edge, so the flow that wrote last is the one displayed.
 *
 * A flow never overwrites a live owner reading: if the owner agent is streaming,
 * its own meter is the writer. `stop()` samples once more, so the status bar
 * keeps the last reading between turns instead of going blank.
 */
function relayTokenRate({ ownerSession, flowSession, label = null } = {}) {
	const ownerMeter = read(ownerSession, "tokenRate");
	const flowMeter = read(flowSession, "tokenRate");
	if (typeof ownerMeter?.seed !== "function" || typeof flowMeter?.rate !== "function") {
		return {
			ok: false,
			reason: BRANCH_SESSION_LIMITS.TOKEN_RATE_UNAVAILABLE,
			detail: LIMIT_DETAIL[BRANCH_SESSION_LIMITS.TOKEN_RATE_UNAVAILABLE],
		};
	}
	let last = null;
	let stopped = false;

	function sample() {
		if (stopped) return last;
		let rate = null;
		try {
			rate = flowMeter.rate();
		} catch {
			return last;
		}
		if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return last;
		if (read(ownerSession, "isStreaming") === true) return last;
		try {
			ownerMeter.seed(rate, 1000);
		} catch {
			return last;
		}
		last = rate;
		return last;
	}

	function stop() {
		if (stopped) return last;
		sample();
		stopped = true;
		return last;
	}

	return {
		ok: true,
		label,
		sample,
		stop,
		state: () => ({ label, last, stopped }),
	};
}

let sdkModulePromise;

function loadSdkModule() {
	sdkModulePromise ??= import("@oh-my-pi/pi-coding-agent").catch(() => null);
	return sdkModulePromise;
}

/**
 * Load the host factory once. A failed import stays failed: the module set is
 * fixed for the life of the process, and retrying only repeats side effects.
 */
function loadCreateAgentSession() {
	return loadSdkModule().then((module) =>
		typeof module?.createAgentSession === "function" ? module.createAgentSession : null,
	);
}

async function loadHostAgentRegistry() {
	const module = await loadSdkModule();
	const AgentRegistry = module?.AgentRegistry;
	if (typeof AgentRegistry?.global !== "function") return null;
	try {
		return AgentRegistry.global();
	} catch {
		return null;
	}
}

/**
 * Derive the `createAgentSession` config for one flow from the owner session.
 *
 * This function is pure apart from reading host getters. It returns
 * `{ ok: false, reason, detail }` for a condition it cannot rebuild without
 * guessing, and `{ ok: true, config, limitations }` otherwise.
 */
export function deriveBranchConfig(options = {}) {
	const owner = options.session;
	if (!owner || typeof owner !== "object") return refusal(BRANCH_SESSION_REASONS.NO_OWNER);

	const flowId = options.flowId;
	if (!isNonEmptyString(flowId) || !FLOW_ID_PATTERN.test(flowId)) {
		return refusal(BRANCH_SESSION_REASONS.NO_FLOW_ID);
	}

	const manager = options.sessionManager;
	if (!manager || typeof manager !== "object") return refusal(BRANCH_SESSION_REASONS.NO_SESSION_MANAGER);

	const limitations = [];
	const inheritedManager = options.asyncJobManager === undefined;
	const asyncJobManager = options.asyncJobManager ?? read(owner, "asyncJobManager");
	if (!asyncJobManager) return refusal(BRANCH_SESSION_REASONS.NO_ASYNC_JOB_MANAGER);
	if (inheritedManager) limitations.push(limitation(BRANCH_SESSION_LIMITS.STREAM_MANAGER_INHERITED));

	const costGate = options.costGate ?? read(owner, "costGate");
	if (!costGate) return refusal(BRANCH_SESSION_REASONS.NO_COST_GATE);

	const model = options.model ?? read(owner, "model");
	if (!model) return refusal(BRANCH_SESSION_REASONS.NO_MODEL);

	const modelRegistry = options.modelRegistry ?? read(owner, "modelRegistry");
	if (!modelRegistry || typeof modelRegistry !== "object") {
		return refusal(BRANCH_SESSION_REASONS.NO_MODEL_REGISTRY);
	}
	const authStorage = read(modelRegistry, "authStorage");
	if (authStorage === undefined || authStorage === null) {
		return refusal(BRANCH_SESSION_REASONS.NO_AUTH_STORAGE);
	}

	const sessionId = read(owner, "sessionId") ?? call(manager, "getSessionId");
	if (!isNonEmptyString(sessionId)) return refusal(BRANCH_SESSION_REASONS.NO_SESSION_ID);

	const settings = options.settings ?? read(owner, "settings");
	if (!settings || typeof settings !== "object") return refusal(BRANCH_SESSION_REASONS.NO_SETTINGS);

	const cwd = options.cwd ?? call(manager, "getCwd");
	if (!isNonEmptyString(cwd)) return refusal(BRANCH_SESSION_REASONS.NO_CWD);

	// The owner's live prompt already carries the managed block the extension
	// injects; the raw session field can predate that injection. Deriving from
	// the live array preserves the prompt supplied to the flow factory.
	// A host that keeps no live copy falls back to the session field,
	// and the flow's own before_agent_start injection is idempotent either way.
	const livePrompt = read(read(read(owner, "agent"), "state"), "systemPrompt");
	const prompt =
		options.systemPrompt ??
		(Array.isArray(livePrompt) ? livePrompt : read(owner, "systemPrompt"));
	if (!Array.isArray(prompt)) return refusal(BRANCH_SESSION_REASONS.NO_SYSTEM_PROMPT);

	const toolNames = options.toolNames ?? call(owner, "getEnabledToolNames");
	const activeToolNames = options.activeToolNames ?? call(owner, "getActiveToolNames");
	const mountedToolNames = options.mountedToolNames ?? mountedToolView(owner);
	if (!Array.isArray(toolNames) || !Array.isArray(activeToolNames) || !Array.isArray(mountedToolNames)) {
		return refusal(BRANCH_SESSION_REASONS.NO_TOOL_VIEW);
	}

	const prepared = read(owner, "preparedExtensions");
	const paths = read(owner, "extensionPaths");
	const preparedSeed = Array.isArray(prepared) && prepared.length ? prepared : undefined;
	const pathSeed = Array.isArray(paths) && paths.length ? [...paths] : undefined;
	if (!preparedSeed && !pathSeed) return refusal(BRANCH_SESSION_REASONS.NO_EXTENSION_SEED);

	const roots = read(owner, "effectiveExtensionRoots");
	const extensionRoots = roots === undefined ? undefined : () => roots;

	const header = call(manager, "getHeader");
	const taskPromptCacheKey = header && typeof header === "object" ? header.taskPromptCacheKey : undefined;
	const agentPromptCacheKey = read(read(owner, "agent"), "promptCacheKey");
	const promptCacheKey = agentPromptCacheKey ?? (taskPromptCacheKey === undefined ? sessionId : undefined);

	const configuredThinking =
		call(owner, "configuredThinkingLevel") ??
		read(owner, "thinkingLevel") ??
		read(read(owner, "agent"), "thinkingLevel");
	const thinkingLevel = options.thinkingLevel ?? (typeof configuredThinking === "string" ? configuredThinking : undefined);

	const artifactsDir = call(manager, "getArtifactsDir");
	const localSessionId = call(manager, "getSessionId");
	const localProtocolOptions =
		artifactsDir !== null && isNonEmptyString(localSessionId)
			? {
					getArtifactsDir: () => manager.getArtifactsDir(),
					getSessionId: () => manager.getSessionId(),
				}
			: undefined;
	if (!localProtocolOptions) limitations.push(limitation(BRANCH_SESSION_LIMITS.LOCAL_PROTOCOL_DEFAULT));

	const parentMnemopiSessionState = call(owner, "getMnemopiSessionState");
	if (!parentMnemopiSessionState) limitations.push(limitation(BRANCH_SESSION_LIMITS.MNEMOPI_ABSENT));

	const ownerAgentId = call(owner, "getAgentId") ?? read(read(owner, "agent"), "agentId") ?? "Main";
	const agentRegistry =
		options.agentRegistry ??
		(options.baseAgentRegistry !== undefined
			? createBranchAgentRegistry({
					baseRegistry: options.baseAgentRegistry,
					flowId,
					ownerAgentId,
				})
			: undefined);
	if (!agentRegistry) limitations.push(limitation(BRANCH_SESSION_LIMITS.GLOBAL_AGENT_REGISTRY));

	// Normalize once, so the limitation list always matches the config it
	// describes. A truthy non-boolean switch still disables the feature, and a
	// disabled feature must never go unreported.
	//
	// An absent option follows the owner. Dropping the owner's LSP or MCP
	// tools changes the tool definitions and can reduce the shared cache prefix.
	// Reusing the owner's handles avoids a second server; the flow borrows the
	// client. The provider-bound request still needs a separate comparison.
	const ownerMcpManager = options.mcpManager ?? read(owner, "mcpManager");
	const ownerMcpTools = options.mcpTools ?? read(owner, "mcpTools");
	const ownerMcpScope = options.mcpToolScope ?? read(owner, "mcpToolScope");
	const enableLsp =
		options.enableLsp === true || read(owner, "enableLsp") === true;
	const enableMCP =
		options.enableMCP === true ||
		(ownerMcpManager !== undefined && ownerMcpManager !== null);
	if (!enableLsp) limitations.push(limitation(BRANCH_SESSION_LIMITS.LSP_DISABLED));
	if (!enableMCP) limitations.push(limitation(BRANCH_SESSION_LIMITS.MCP_NOT_FOLLOWED));
	limitations.push(limitation(BRANCH_SESSION_LIMITS.SETTINGS_SHARED));
	limitations.push(limitation(BRANCH_SESSION_LIMITS.SHARED_MANAGER_DISPOSE_FORBIDDEN));

	// The display name is the scope title the station passes for a fork; the
	// flow id remains the agent identity. An explicit label still wins, and a
	// branch with neither keeps its flow id instead of an empty AgentRef.
	const label = isNonEmptyString(options.label)
		? options.label
		: isNonEmptyString(options.agentDisplayName)
			? options.agentDisplayName
			: flowId;

	const config = {
		cwd,
		costGate,
		sessionManager: manager,
		model,
		thinkingLevel,
		systemPrompt: [...prompt],
		toolNames: [...toolNames],
		mountedToolNames: [...mountedToolNames],
		advertiseHeadlessAsk: activeToolNames.includes("ask"),
		// Keep the owner's cache route when constructing a peer flow. A shared
		// route helps reuse a matching prefix but does not guarantee cache hits.
		providerSessionId: sessionId,
		providerPromptCacheKey: promptCacheKey,
		taskPromptCacheKey,
		modelRegistry,
		authStorage,
		settings,
		hasUI: false,
		enableMCP,
		mcpManager: ownerMcpManager,
		mcpTools: ownerMcpTools,
		mcpToolScope: ownerMcpScope,
		enableLsp,
		bindProcessState: false,
		agentId: flowId,
		agentDisplayName: label,
		asyncJobManager,
		agentRegistry,
		disableExtensionDiscovery: true,
		preloadedPreparedExtensions: preparedSeed,
		preloadedExtensionPaths: pathSeed,
		extensionRoots,
		localProtocolOptions,
		parentMnemopiSessionState: parentMnemopiSessionState ?? undefined,
	};

	return { ok: true, config, limitations };
}

/**
 * Build one flow's AgentSession.
 *
 * Returns `{ ok: true, session, config, limitations, originEntryId }` or
 * `{ ok: false, reason, detail }`. `originEntryId` is the inherited tip (`null`
 * for an empty prefix), or `undefined` when the manager cannot isolate a tip.
 * On success the caller owns event forwarding and must not dispose the
 * session (see the file header and the
 * SHARED_MANAGER_DISPOSE_FORBIDDEN limitation).
 */
/**
 * Rebuild one session over a stopped child's branch.
 *
 * The branch outlives the session: it lives in the shared manager under the
 * child's agent id, and the record keeps its leaf as `branchTail`. A resume
 * opens the same flow at that leaf, lets the caller bind the child's station
 * (the identity is installed by the caller before this call), and hands back a
 * one-shot prompt. Teardown is the caller's: dispose the session, close the
 * flow, drop the identity — the record itself is never touched.
 *
 * Returns null for anything it cannot rebuild: a failed record, a record with
 * no agent id, a manager that cannot proxy, or a factory refusal.
 */
export async function createBranchSession(options = {}) {
	const baseAgentRegistry =
		options.agentRegistry === undefined && options.baseAgentRegistry === undefined
			? await loadHostAgentRegistry()
			: options.baseAgentRegistry;
	const derived = deriveBranchConfig(
		options.agentRegistry === undefined
			? { ...options, baseAgentRegistry }
			: options,
	);
	if (!derived.ok) return derived;
	if (options.sourceToolCallId != null) await options.session.settleInFlightMessagePersistence?.();

	let config = derived.config;
	let limitations = derived.limitations;
	let flowManager = null;
	let originEntryId;
	const parentManager = derived.config.sessionManager;
	const shared = sharedManagerOf(parentManager);
	if (canProxyBranchManager(shared)) {
		const label = derived.config.agentDisplayName;
		if (options.upscopeSnapshotLeafId != null) {
			const snapId = options.upscopeSnapshotLeafId;
			const snapBranch =
				typeof shared.getBranch === "function" ? shared.getBranch(snapId) : null;
			if (!Array.isArray(snapBranch) || snapBranch.length === 0 || snapBranch.at(-1)?.id !== snapId) {
				return refusal(BRANCH_SESSION_REASONS.NO_UPSCOPE_SNAPSHOT);
			}
			if (!isClosedSnapshotBranch(snapBranch)) {
				return refusal(BRANCH_SESSION_REASONS.UPSCOPE_SNAPSHOT_UNSAFE);
			}
			originEntryId = snapId;
		} else {
			const parentBranch = parentManager.getBranch();
			const sourceIndex = options.sourceToolCallId == null ? -1 : parentBranch.findLastIndex((entry) =>
				entry.type === "message" && entry.message?.role === "assistant" &&
				entry.message.content?.some((block) => block.type === "toolCall" && block.id === options.sourceToolCallId),
			);
			if (options.sourceToolCallId != null && sourceIndex < 0) {
				return refusal(BRANCH_SESSION_REASONS.NO_FORK_FRAME);
			}
			originEntryId = (sourceIndex < 0 ? parentBranch.at(-1) : parentBranch[sourceIndex - 1])?.id ?? null;
		}
		retainSessionLease(shared);
		flowManager = createBranchManager(shared, { flowId: options.flowId, label, tail: originEntryId });
		config = { ...derived.config, sessionManager: flowManager };
	} else {
		limitations = [...limitations, limitation(BRANCH_SESSION_LIMITS.SHARED_MANAGER_NOT_PROXIED)];
	}

	async function fail(reason, extra = {}) {
		if (flowManager) {
			try {
				await flowManager.close();
			} catch {
				// The refusal is the answer; a release failure adds nothing.
			}
		}
		return refusal(reason, { config, limitations, ...extra });
	}

	const factory = options.createAgentSession ?? (await loadCreateAgentSession());
	if (typeof factory !== "function") return fail(BRANCH_SESSION_REASONS.NO_SDK);

	let created;
	try {
		created = await factory(config);
	} catch (error) {
		return fail(BRANCH_SESSION_REASONS.CREATE_FAILED, { error });
	}

	if (!created || typeof created.session !== "object" || created.session === null) {
		return fail(BRANCH_SESSION_REASONS.CREATE_RETURNED_NOTHING);
	}

	// Route this flow's tool approvals to the owner interface under the flow's
	// label. The result's setToolUIContext is the host's public seam; a flow is
	// built headless, so without this call an approval prompt cannot name the
	// requesting flow. The raw context is also registered on the flow session,
	// so a nested batch opened by this flow labels itself with its full path.
	const ownerUI = options.ui ?? ownerUIContexts.get(options.session) ?? null;
	let toolUI = null;
	if (typeof created.setToolUIContext !== "function") {
		limitations = [...limitations, limitation(BRANCH_SESSION_LIMITS.TOOL_UI_UNSUPPORTED)];
	} else if (!ownerUI) {
		limitations = [...limitations, limitation(BRANCH_SESSION_LIMITS.OWNER_UI_ABSENT)];
	} else {
		try {
			const headless = created.session.extensionRunner?.createContext?.()?.ui;
			created.setToolUIContext(labelledUIContext(ownerUI, config.agentDisplayName, headless), true);
			toolUI = Object.freeze({ installed: true, label: config.agentDisplayName });
			registerOwnerUI(created.session, ownerUI);
		} catch {
			limitations = [...limitations, limitation(BRANCH_SESSION_LIMITS.TOOL_UI_UNSUPPORTED)];
		}
	}

	return {
		ok: true,
		session: created.session,
		originEntryId,
		config,
		limitations,
		toolUI,
		frames: options.session ? compareBranchFrames(options.session, config) : null,
		setToolUIContext: typeof created.setToolUIContext === "function" ? created.setToolUIContext : null,
		eventBus: created.eventBus,
		extensionsResult: created.extensionsResult,
	};
}
