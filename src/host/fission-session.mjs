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
 * The factory installs no UI bridge, event bridge, extension hook, or
 * session_init entry. The caller owns event forwarding. The caller must also
 * never call `dispose()` on a flow session: the host dispose path seals and
 * closes the shared SessionManager, which stops every other flow from writing.
 */

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
});

/** Flow ids feed file names and provider ids, so keep them label-safe. */
const FLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const DETAIL = Object.freeze({
	[FISSION_SESSION_REASONS.NO_OWNER]: "The source session is absent or not an object.",
	[FISSION_SESSION_REASONS.NO_FLOW_ID]:
		"flowId must match /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/. It becomes the agent id, the task prefix, and part of the provider session id.",
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
		"Never call dispose() on a flow session. The host dispose path seals and closes the shared SessionManager, which stops every other flow from writing.",
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

	const prompt = options.systemPrompt ?? read(owner, "systemPrompt");
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
	const enableLsp = options.enableLsp === true;
	const enableMCP = options.enableMCP === true;
	if (!enableLsp) limitations.push(limitation(FISSION_SESSION_LIMITS.LSP_DISABLED));
	if (!enableMCP) limitations.push(limitation(FISSION_SESSION_LIMITS.MCP_NOT_FOLLOWED));
	limitations.push(limitation(FISSION_SESSION_LIMITS.SETTINGS_SHARED));
	limitations.push(limitation(FISSION_SESSION_LIMITS.SHARED_MANAGER_DISPOSE_FORBIDDEN));

	const ownerId = call(owner, "getAgentId");
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
		providerSessionId: `${sessionId}:fission:${flowId}`,
		providerPromptCacheKey: promptCacheKey,
		taskPromptCacheKey,
		modelRegistry,
		authStorage,
		settings,
		hasUI: false,
		enableMCP,
		mcpManager: options.mcpManager,
		mcpTools: options.mcpTools,
		mcpToolScope: options.mcpToolScope,
		enableLsp,
		bindProcessState: false,
		agentId: flowId,
		agentDisplayName: label,
		parentTaskPrefix: flowId,
		asyncJobManager,
		parentAgentId: isNonEmptyString(ownerId) ? ownerId : "Main",
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

	const factory = options.createAgentSession ?? (await loadCreateAgentSession());
	if (typeof factory !== "function") {
		return refusal(FISSION_SESSION_REASONS.NO_SDK, {
			config: derived.config,
			limitations: derived.limitations,
		});
	}

	let created;
	try {
		created = await factory(derived.config);
	} catch (error) {
		return refusal(FISSION_SESSION_REASONS.CREATE_FAILED, {
			error,
			config: derived.config,
			limitations: derived.limitations,
		});
	}

	if (!created || typeof created.session !== "object" || created.session === null) {
		return refusal(FISSION_SESSION_REASONS.CREATE_RETURNED_NOTHING, {
			config: derived.config,
			limitations: derived.limitations,
		});
	}

	return {
		ok: true,
		session: created.session,
		config: derived.config,
		limitations: derived.limitations,
		eventBus: created.eventBus,
		extensionsResult: created.extensionsResult,
	};
}
