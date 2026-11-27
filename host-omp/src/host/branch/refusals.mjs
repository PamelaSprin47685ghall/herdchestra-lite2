// The two vocabularies a branch construction speaks, and the sentence behind
// each word.
//
// A refusal code is a machine fact: callers branch on it, and a test names it. A
// limitation code is a faith-keeping fact: the construction succeeded, and this
// is the named gap. Both are pure data — no session, no host, no read — so they
// live beside each other instead of inside the factory that raises them.

/** Stable reason codes for a refused construction. */
export const BRANCH_SESSION_REASONS = Object.freeze({
	NO_OWNER: "NO_OWNER",
	NO_FORK_FRAME: "NO_FORK_FRAME",
	NO_UPSCOPE_SNAPSHOT: "NO_UPSCOPE_SNAPSHOT",
	UPSCOPE_SNAPSHOT_UNSAFE: "UPSCOPE_SNAPSHOT_UNSAFE",
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
export const BRANCH_SESSION_LIMITS = Object.freeze({
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
export const FLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const DETAIL = Object.freeze({
	[BRANCH_SESSION_REASONS.NO_OWNER]: "The source session is absent or not an object.",
	[BRANCH_SESSION_REASONS.NO_FORK_FRAME]: "The parent journal does not contain the assistant frame which requested this fork.",
	[BRANCH_SESSION_REASONS.NO_UPSCOPE_SNAPSHOT]: "The upscope snapshot leaf does not exist in the shared session manager.",
	[BRANCH_SESSION_REASONS.UPSCOPE_SNAPSHOT_UNSAFE]: "The upscope snapshot leaf contains an unclosed tool call without a tool result.",
	[BRANCH_SESSION_REASONS.NO_FLOW_ID]:
		"flowId must match /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/. It becomes the agent id and a local flow label.",
	[BRANCH_SESSION_REASONS.NO_SESSION_MANAGER]:
		"The shared SessionManager is required. A flow must not create one, because a second manager writes a second transcript and holds a second lease.",
	[BRANCH_SESSION_REASONS.NO_ASYNC_JOB_MANAGER]:
		"The job manager is required. Without it the host resolves a process-global manager, which duplicates delivery sinks across flows.",
	[BRANCH_SESSION_REASONS.NO_COST_GATE]:
		"A cost gate is required. Without one the flow creates its own gate, and `session.maxCost` becomes N times larger.",
	[BRANCH_SESSION_REASONS.NO_MODEL]: "Neither the option nor the owner session supplies a model.",
	[BRANCH_SESSION_REASONS.NO_MODEL_REGISTRY]: "The owner session exposes no model registry.",
	[BRANCH_SESSION_REASONS.NO_AUTH_STORAGE]: "The model registry exposes no auth storage.",
	[BRANCH_SESSION_REASONS.NO_SESSION_ID]: "Neither the owner session nor the manager exposes a session id.",
	[BRANCH_SESSION_REASONS.NO_SETTINGS]: "Neither the option nor the owner session supplies settings.",
	[BRANCH_SESSION_REASONS.NO_CWD]: "Neither the option nor the manager supplies a working directory.",
	[BRANCH_SESSION_REASONS.NO_SYSTEM_PROMPT]: "The owner session exposes no system prompt array.",
	[BRANCH_SESSION_REASONS.NO_TOOL_VIEW]:
		"The owner session exposes no tool view (enabled, active, and mounted tool names), so the flow's tool set cannot be rebuilt faithfully.",
	[BRANCH_SESSION_REASONS.NO_EXTENSION_SEED]:
		"The owner exposes neither prepared extensions nor extension paths. With discovery disabled the flow would build an empty extension set, and the host extension sync would prune the shared registry's provider registrations (the no-key failure).",
	[BRANCH_SESSION_REASONS.NO_SDK]: "The host package does not export createAgentSession.",
	[BRANCH_SESSION_REASONS.CREATE_FAILED]: "The host factory threw during construction.",
	[BRANCH_SESSION_REASONS.CREATE_RETURNED_NOTHING]: "The host factory returned no session object.",
});

export const LIMIT_DETAIL = Object.freeze({
	[BRANCH_SESSION_LIMITS.LSP_DISABLED]:
		"The host reads its task LSP switch from an internal settings object that the extension layer cannot reach. The flow passes enableLsp: false instead of starting duplicate LSP servers.",
	[BRANCH_SESSION_LIMITS.MCP_NOT_FOLLOWED]:
		"No MCP manager or follower proxies were supplied. The flow passes enableMCP: false and receives no MCP tools.",
	[BRANCH_SESSION_LIMITS.SETTINGS_SHARED]:
		"The host derives subagent settings through an internal helper. The flow shares the owner settings instance by reference, so task.* subagent overrides do not apply.",
	[BRANCH_SESSION_LIMITS.STREAM_MANAGER_INHERITED]:
		"The async job manager came from the owner session, not from the caller. Pass the batch's manager explicitly when flows must share one.",
	[BRANCH_SESSION_LIMITS.LOCAL_PROTOCOL_DEFAULT]:
		"The shared manager exposes no getArtifactsDir/getSessionId pair. localProtocolOptions is omitted and the flow uses the host default for local:// resolution.",
	[BRANCH_SESSION_LIMITS.GLOBAL_AGENT_REGISTRY]:
		"No agent registry was supplied. The flow registers in the global registry, which admits one Main per process generation.",
	[BRANCH_SESSION_LIMITS.MNEMOPI_ABSENT]:
		"The owner exposes no getMnemopiSessionState(). The flow starts without inherited memory recall.",
	[BRANCH_SESSION_LIMITS.SHARED_MANAGER_DISPOSE_FORBIDDEN]:
		"Never call dispose() on a flow session. The host dispose path seals and closes the shared SessionManager, which stops every other flow from writing. The flow proxy reference-counts seal/close, so one flow's disposal cannot seal the journal while a sibling still holds it.",
	[BRANCH_SESSION_LIMITS.SHARED_MANAGER_NOT_PROXIED]:
		"The shared manager does not expose the leaf contract (getLeafId/getBranch/branch/resetLeaf/seal/close and getEntry/getEntries), so this flow keeps the raw manager. A real SessionManager always supports the proxy.",
	[BRANCH_SESSION_LIMITS.TOOL_UI_UNSUPPORTED]:
		"The host factory result exposes no setToolUIContext(), so a flow's tool approval cannot be routed to the owner interface. The flow keeps the host's headless tool UI.",
	[BRANCH_SESSION_LIMITS.OWNER_UI_ABSENT]:
		"No owner interface context was registered for this session. The flow keeps the host's headless tool UI, so an approval prompt cannot name the requesting flow.",
	[BRANCH_SESSION_LIMITS.TOKEN_RATE_UNAVAILABLE]:
		"Either the owner session or the flow session exposes no TokenRateMeter with the expected methods, so a flow's generation rate cannot be forwarded to the session the status bar reads.",
});
