/**
 * Fission session factory.
 *
 * One fission flow runs in its own AgentSession. This module builds that
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
	canProxyFissionManager,
	createFissionManager,
	createFlowTailResolver,
	retainFissionManager,
} from "./fission-manager.mjs";
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
export function compareFissionFrames(owner, config) {
	const ownerPrompt =
		read(read(read(owner, "agent"), "state"), "systemPrompt") ??
		read(owner, "systemPrompt");
	const ownerTools = call(owner, "getEnabledToolNames");
	const ownerMounted = call(owner, "getMountedXdevToolNames");
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
export function compareMessagePrefix(ownerPrefix, flowMessages) {
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

/** Stable reason codes for a refused construction. */
export const FISSION_SESSION_REASONS = Object.freeze({
	NO_OWNER: "NO_OWNER",
	NO_FLOW_ID: "NO_FLOW_ID",
	NO_SESSION_MANAGER: "NO_SESSION_MANAGER",
	NO_ASYNC_JOB_MANAGER: "NO_ASYNC_JOB_MANAGER",
	NO_COST_GATE: "NO_COST_GATE",
	NO_MODEL: "NO_MODEL",
	NO_MODEL_REGISTRY: "NO_MODEL_REGISTRY",
	NO_AUTH_STORAGE: "NO_AUTH_STORAGE",
	NO_SESSION_ID: "NO_SESSION_ID",
	NO_SETTINGS: "NO_SETTINGS",
	NO_CWD: "NO_CWD",
	NO_SYSTEM_PROMPT: "NO_SYSTEM_PROMPT",
	NO_TOOL_VIEW: "NO_TOOL_VIEW",
	NO_EXTENSION_SEED: "NO_EXTENSION_SEED",
	NO_SDK: "NO_SDK",
	CREATE_FAILED: "CREATE_FAILED",
	CREATE_RETURNED_NOTHING: "CREATE_RETURNED_NOTHING",
});

/** Stable codes for a faithful construction with a known, named gap. */
export const FISSION_SESSION_LIMITS = Object.freeze({
	LSP_DISABLED: "LSP_DISABLED",
	MCP_NOT_FOLLOWED: "MCP_NOT_FOLLOWED",
	SETTINGS_SHARED: "SETTINGS_SHARED",
	STREAM_MANAGER_INHERITED: "STREAM_MANAGER_INHERITED",
	LOCAL_PROTOCOL_DEFAULT: "LOCAL_PROTOCOL_DEFAULT",
	GLOBAL_AGENT_REGISTRY: "GLOBAL_AGENT_REGISTRY",
	MNEMOPI_ABSENT: "MNEMOPI_ABSENT",
	SHARED_MANAGER_DISPOSE_FORBIDDEN: "SHARED_MANAGER_DISPOSE_FORBIDDEN",
	SHARED_MANAGER_NOT_PROXIED: "SHARED_MANAGER_NOT_PROXIED",
	TOOL_UI_UNSUPPORTED: "TOOL_UI_UNSUPPORTED",
	OWNER_UI_ABSENT: "OWNER_UI_ABSENT",
	TOKEN_RATE_UNAVAILABLE: "TOKEN_RATE_UNAVAILABLE",
});

/** Flow ids feed file names and agent ids, so keep them label-safe. */
const FLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const DETAIL = Object.freeze({
	[FISSION_SESSION_REASONS.NO_OWNER]: "The source session is absent or not an object.",
	[FISSION_SESSION_REASONS.NO_FLOW_ID]:
		"flowId must match /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/. It becomes the agent id and a local flow label.",
	[FISSION_SESSION_REASONS.NO_SESSION_MANAGER]:
		"The shared SessionManager is required. A flow must not create one, because a second manager writes a second transcript and holds a second lease.",
	[FISSION_SESSION_REASONS.NO_ASYNC_JOB_MANAGER]:
		"The job manager is required. Without it the host resolves a process-global manager, which duplicates delivery sinks across flows.",
	[FISSION_SESSION_REASONS.NO_COST_GATE]:
		"A cost gate is required. Without one the flow creates its own gate, and `session.maxCost` becomes N times larger.",
	[FISSION_SESSION_REASONS.NO_MODEL]: "Neither the option nor the owner session supplies a model.",
	[FISSION_SESSION_REASONS.NO_MODEL_REGISTRY]: "The owner session exposes no model registry.",
	[FISSION_SESSION_REASONS.NO_AUTH_STORAGE]: "The model registry exposes no auth storage.",
	[FISSION_SESSION_REASONS.NO_SESSION_ID]: "Neither the owner session nor the manager exposes a session id.",
	[FISSION_SESSION_REASONS.NO_SETTINGS]: "Neither the option nor the owner session supplies settings.",
	[FISSION_SESSION_REASONS.NO_CWD]: "Neither the option nor the manager supplies a working directory.",
	[FISSION_SESSION_REASONS.NO_SYSTEM_PROMPT]: "The owner session exposes no system prompt array.",
	[FISSION_SESSION_REASONS.NO_TOOL_VIEW]:
		"The owner session exposes no tool view (enabled, active, and mounted tool names), so the flow's tool set cannot be rebuilt faithfully.",
	[FISSION_SESSION_REASONS.NO_EXTENSION_SEED]:
		"The owner exposes neither prepared extensions nor extension paths. With discovery disabled the flow would build an empty extension set, and the host extension sync would prune the shared registry's provider registrations (the no-key failure).",
	[FISSION_SESSION_REASONS.NO_SDK]: "The host package does not export createAgentSession.",
	[FISSION_SESSION_REASONS.CREATE_FAILED]: "The host factory threw during construction.",
	[FISSION_SESSION_REASONS.CREATE_RETURNED_NOTHING]: "The host factory returned no session object.",
});

const LIMIT_DETAIL = Object.freeze({
	[FISSION_SESSION_LIMITS.LSP_DISABLED]:
		"The host reads its task LSP switch from an internal settings object that the extension layer cannot reach. The flow passes enableLsp: false instead of starting duplicate LSP servers.",
	[FISSION_SESSION_LIMITS.MCP_NOT_FOLLOWED]:
		"No MCP manager or follower proxies were supplied. The flow passes enableMCP: false and receives no MCP tools.",
	[FISSION_SESSION_LIMITS.SETTINGS_SHARED]:
		"The host derives subagent settings through an internal helper. The flow shares the owner settings instance by reference, so task.* subagent overrides do not apply.",
	[FISSION_SESSION_LIMITS.STREAM_MANAGER_INHERITED]:
		"The async job manager came from the owner session, not from the caller. Pass the batch's manager explicitly when flows must share one.",
	[FISSION_SESSION_LIMITS.LOCAL_PROTOCOL_DEFAULT]:
		"The shared manager exposes no getArtifactsDir/getSessionId pair. localProtocolOptions is omitted and the flow uses the host default for local:// resolution.",
	[FISSION_SESSION_LIMITS.GLOBAL_AGENT_REGISTRY]:
		"No agent registry was supplied. The flow registers in the global registry, which admits one Main per process generation.",
	[FISSION_SESSION_LIMITS.MNEMOPI_ABSENT]:
		"The owner exposes no getMnemopiSessionState(). The flow starts without inherited memory recall.",
	[FISSION_SESSION_LIMITS.SHARED_MANAGER_DISPOSE_FORBIDDEN]:
		"Never call dispose() on a flow session. The host dispose path seals and closes the shared SessionManager, which stops every other flow from writing. The flow proxy reference-counts seal/close, so one flow's disposal cannot seal the journal while a sibling still holds it.",
	[FISSION_SESSION_LIMITS.SHARED_MANAGER_NOT_PROXIED]:
		"The shared manager does not expose the leaf contract (getLeafId/getBranch/branch/resetLeaf/seal/close and getEntry/getEntries), so this flow keeps the raw manager. A real SessionManager always supports the proxy.",
	[FISSION_SESSION_LIMITS.TOOL_UI_UNSUPPORTED]:
		"The host factory result exposes no setToolUIContext(), so a flow's tool approval cannot be routed to the owner interface. The flow keeps the host's headless tool UI.",
	[FISSION_SESSION_LIMITS.OWNER_UI_ABSENT]:
		"No owner interface context was registered for this session. The flow keeps the host's headless tool UI, so an approval prompt cannot name the requesting flow.",
	[FISSION_SESSION_LIMITS.TOKEN_RATE_UNAVAILABLE]:
		"Either the owner session or the flow session exposes no TokenRateMeter with the expected methods, so a flow's generation rate cannot be forwarded to the session the status bar reads.",
});

function read(target, key) {
	if (!target || typeof target !== "object") return undefined;
	try {
		return target[key];
	} catch {
		return undefined;
	}
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

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

// One session-scoped lease per shared manager. It is never released: the owner
// session owns the manager's lifetime, so a flow's dispose drops only that
// flow's lease and can never seal the journal out from under its siblings.
const sessionLeases = new WeakSet();

function retainSessionLease(shared) {
	if (sessionLeases.has(shared)) return;
	retainFissionManager(shared);
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
const LABELLED_PROMPT_METHODS = Object.freeze(["select", "confirm", "input", "editor", "notify"]);

function labelText(text, label) {
	if (typeof text !== "string" || text === "") return `Fission flow ${label}`;
	return `Fission flow ${label}\n${text}`;
}

/**
 * Wrap one interface context so every prompt names the requesting flow.
 *
 * The approval dialog receives `full` and `compact` prompts; both get the
 * label line, while the answer is returned unchanged. Methods this wrapper
 * does not know stay delegated with their own receiver. Returns null for an
 * absent context, so the caller reports the gap rather than showing an
 * unlabelled prompt.
 */
export function labelledUIContext(ui, label) {
	if (!ui || typeof ui !== "object") return null;
	const name = typeof label === "string" && label !== "" ? label : "unnamed";
	return new Proxy(ui, {
		get(target, property) {
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
			if (LABELLED_PROMPT_METHODS.includes(property)) {
				return (first, ...rest) => {
					const shown = typeof first === "string" ? labelText(first, name) : first;
					return value.call(target, shown, ...rest);
				};
			}
			return value.bind(target);
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
export function relayTokenRate({ ownerSession, flowSession, label = null } = {}) {
	const ownerMeter = read(ownerSession, "tokenRate");
	const flowMeter = read(flowSession, "tokenRate");
	if (typeof ownerMeter?.seed !== "function" || typeof flowMeter?.rate !== "function") {
		return {
			ok: false,
			reason: FISSION_SESSION_LIMITS.TOKEN_RATE_UNAVAILABLE,
			detail: LIMIT_DETAIL[FISSION_SESSION_LIMITS.TOKEN_RATE_UNAVAILABLE],
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

let factoryPromise;

/**
 * Load the host factory once. A failed import stays failed: the module set is
 * fixed for the life of the process, and retrying only repeats side effects.
 */
export function loadCreateAgentSession() {
	factoryPromise ??= import("@oh-my-pi/pi-coding-agent")
		.then((module) => (typeof module?.createAgentSession === "function" ? module.createAgentSession : null))
		.catch(() => null);
	return factoryPromise;
}

/**
 * Derive the `createAgentSession` config for one flow from the owner session.
 *
 * This function is pure apart from reading host getters. It returns
 * `{ ok: false, reason, detail }` for a condition it cannot rebuild without
 * guessing, and `{ ok: true, config, limitations }` otherwise.
 */
export function deriveFissionConfig(options = {}) {
	const owner = options.session;
	if (!owner || typeof owner !== "object") return refusal(FISSION_SESSION_REASONS.NO_OWNER);

	const flowId = options.flowId;
	if (!isNonEmptyString(flowId) || !FLOW_ID_PATTERN.test(flowId)) {
		return refusal(FISSION_SESSION_REASONS.NO_FLOW_ID);
	}

	const manager = options.sessionManager;
	if (!manager || typeof manager !== "object") return refusal(FISSION_SESSION_REASONS.NO_SESSION_MANAGER);

	const limitations = [];
	const inheritedManager = options.asyncJobManager === undefined;
	const asyncJobManager = options.asyncJobManager ?? read(owner, "asyncJobManager");
	if (!asyncJobManager) return refusal(FISSION_SESSION_REASONS.NO_ASYNC_JOB_MANAGER);
	if (inheritedManager) limitations.push(limitation(FISSION_SESSION_LIMITS.STREAM_MANAGER_INHERITED));

	const costGate = options.costGate ?? read(owner, "costGate");
	if (!costGate) return refusal(FISSION_SESSION_REASONS.NO_COST_GATE);

	const model = options.model ?? read(owner, "model");
	if (!model) return refusal(FISSION_SESSION_REASONS.NO_MODEL);

	const modelRegistry = options.modelRegistry ?? read(owner, "modelRegistry");
	if (!modelRegistry || typeof modelRegistry !== "object") {
		return refusal(FISSION_SESSION_REASONS.NO_MODEL_REGISTRY);
	}
	const authStorage = read(modelRegistry, "authStorage");
	if (authStorage === undefined || authStorage === null) {
		return refusal(FISSION_SESSION_REASONS.NO_AUTH_STORAGE);
	}

	const sessionId = read(owner, "sessionId") ?? call(manager, "getSessionId");
	if (!isNonEmptyString(sessionId)) return refusal(FISSION_SESSION_REASONS.NO_SESSION_ID);

	const settings = options.settings ?? read(owner, "settings");
	if (!settings || typeof settings !== "object") return refusal(FISSION_SESSION_REASONS.NO_SETTINGS);

	const cwd = options.cwd ?? call(manager, "getCwd");
	if (!isNonEmptyString(cwd)) return refusal(FISSION_SESSION_REASONS.NO_CWD);

	// The owner's live prompt already carries the managed block the extension
	// injects; the raw session field can predate that injection. Deriving from
	// the live array preserves the prompt supplied to the flow factory.
	// A host that keeps no live copy falls back to the session field,
	// and the flow's own before_agent_start injection is idempotent either way.
	const livePrompt = read(read(read(owner, "agent"), "state"), "systemPrompt");
	const prompt =
		options.systemPrompt ??
		(Array.isArray(livePrompt) ? livePrompt : read(owner, "systemPrompt"));
	if (!Array.isArray(prompt)) return refusal(FISSION_SESSION_REASONS.NO_SYSTEM_PROMPT);

	const toolNames = options.toolNames ?? call(owner, "getEnabledToolNames");
	const activeToolNames = options.activeToolNames ?? call(owner, "getActiveToolNames");
	const mountedToolNames = options.mountedToolNames ?? call(owner, "getMountedXdevToolNames");
	if (!Array.isArray(toolNames) || !Array.isArray(activeToolNames) || !Array.isArray(mountedToolNames)) {
		return refusal(FISSION_SESSION_REASONS.NO_TOOL_VIEW);
	}

	const prepared = read(owner, "preparedExtensions");
	const paths = read(owner, "extensionPaths");
	const preparedSeed = Array.isArray(prepared) && prepared.length ? prepared : undefined;
	const pathSeed = Array.isArray(paths) && paths.length ? [...paths] : undefined;
	if (!preparedSeed && !pathSeed) return refusal(FISSION_SESSION_REASONS.NO_EXTENSION_SEED);

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
	if (!localProtocolOptions) limitations.push(limitation(FISSION_SESSION_LIMITS.LOCAL_PROTOCOL_DEFAULT));

	const parentMnemopiSessionState = call(owner, "getMnemopiSessionState");
	if (!parentMnemopiSessionState) limitations.push(limitation(FISSION_SESSION_LIMITS.MNEMOPI_ABSENT));

	const agentRegistry = options.agentRegistry;
	if (!agentRegistry) limitations.push(limitation(FISSION_SESSION_LIMITS.GLOBAL_AGENT_REGISTRY));

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
	if (!enableLsp) limitations.push(limitation(FISSION_SESSION_LIMITS.LSP_DISABLED));
	if (!enableMCP) limitations.push(limitation(FISSION_SESSION_LIMITS.MCP_NOT_FOLLOWED));
	limitations.push(limitation(FISSION_SESSION_LIMITS.SETTINGS_SHARED));
	limitations.push(limitation(FISSION_SESSION_LIMITS.SHARED_MANAGER_DISPOSE_FORBIDDEN));

	const label = isNonEmptyString(options.label) ? options.label : flowId;

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
 * Returns `{ ok: true, session, config, limitations }` or
 * `{ ok: false, reason, detail }`. On refusal nothing is created and no host
 * side effect runs. On success the caller owns event forwarding and must not
 * dispose the session (see the file header and the
 * SHARED_MANAGER_DISPOSE_FORBIDDEN limitation).
 */
export async function createFissionSession(options = {}) {
	const derived = deriveFissionConfig(options);
	if (!derived.ok) return derived;

	// A real SessionManager exposes the leaf contract, so the flow gets a proxy
	// that writes its own branch and reference-counts seal/close. A manager
	// without a leaf at all cannot cross-write branches; that gap is reported
	// instead of guessed at.
	let config = derived.config;
	let limitations = derived.limitations;
	let flowManager = null;
	if (canProxyFissionManager(derived.config.sessionManager)) {
		const shared = derived.config.sessionManager;
		const label = derived.config.agentDisplayName;
		retainSessionLease(shared);
		flowManager = createFissionManager(shared, {
			flowId: options.flowId,
			label,
			resolveTail: createFlowTailResolver(shared, { flowId: options.flowId, label }),
		});
		config = { ...derived.config, sessionManager: flowManager };
	} else {
		limitations = [...limitations, limitation(FISSION_SESSION_LIMITS.SHARED_MANAGER_NOT_PROXIED)];
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
	if (typeof factory !== "function") return fail(FISSION_SESSION_REASONS.NO_SDK);

	let created;
	try {
		created = await factory(config);
	} catch (error) {
		return fail(FISSION_SESSION_REASONS.CREATE_FAILED, { error });
	}

	if (!created || typeof created.session !== "object" || created.session === null) {
		return fail(FISSION_SESSION_REASONS.CREATE_RETURNED_NOTHING);
	}

	// Route this flow's tool approvals to the owner interface under the flow's
	// label. The result's setToolUIContext is the host's public seam; a flow is
	// built headless, so without this call an approval prompt cannot name the
	// requesting flow. The raw context is also registered on the flow session,
	// so a nested batch opened by this flow labels itself with its full path.
	const ownerUI = options.ui ?? ownerUIContexts.get(options.session) ?? null;
	let toolUI = null;
	if (typeof created.setToolUIContext !== "function") {
		limitations = [...limitations, limitation(FISSION_SESSION_LIMITS.TOOL_UI_UNSUPPORTED)];
	} else if (!ownerUI) {
		limitations = [...limitations, limitation(FISSION_SESSION_LIMITS.OWNER_UI_ABSENT)];
	} else {
		try {
			created.setToolUIContext(labelledUIContext(ownerUI, config.agentDisplayName), true);
			toolUI = Object.freeze({ installed: true, label: config.agentDisplayName });
			registerOwnerUI(created.session, ownerUI);
		} catch {
			limitations = [...limitations, limitation(FISSION_SESSION_LIMITS.TOOL_UI_UNSUPPORTED)];
		}
	}

	return {
		ok: true,
		session: created.session,
		config,
		limitations,
		toolUI,
		frames: options.session ? compareFissionFrames(options.session, config) : null,
		setToolUIContext: typeof created.setToolUIContext === "function" ? created.setToolUIContext : null,
		eventBus: created.eventBus,
		extensionsResult: created.extensionsResult,
	};
}
