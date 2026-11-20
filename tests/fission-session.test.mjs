import { describe, expect, test } from "bun:test";

import {
	FISSION_SESSION_LIMITS,
	FISSION_SESSION_REASONS,
	createFissionSession,
	deriveFissionConfig,
} from "../src/host/fission-session.mjs";

const ASYNC_JOBS = { kind: "asyncJobManager" };
const COST_GATE = { kind: "costGate" };
const MODEL = { id: "model-1" };
const AUTH_STORAGE = { kind: "authStorage" };
const MODEL_REGISTRY = { authStorage: AUTH_STORAGE };
const SETTINGS = { kind: "settings" };
const AGENT_REGISTRY = { kind: "agentRegistry" };
const PREPARED = { name: "prepared-extension" };
const EXTENSION_PATH = "/extensions/base.mjs";
const MNEMOPI = { memory: "inherited" };

function createManager(overrides = {}) {
	return {
		getSessionId: () => "session-1",
		getCwd: () => "/workspace",
		getHeader: () => ({ taskPromptCacheKey: "task-cache" }),
		getArtifactsDir: () => "/artifacts",
		...overrides,
	};
}

function createOwner(overrides = {}) {
	return {
		asyncJobManager: ASYNC_JOBS,
		costGate: COST_GATE,
		model: MODEL,
		modelRegistry: MODEL_REGISTRY,
		sessionId: "session-1",
		settings: SETTINGS,
		systemPrompt: ["owner prompt"],
		preparedExtensions: [PREPARED],
		extensionPaths: [EXTENSION_PATH],
		agent: { promptCacheKey: "agent-cache", thinkingLevel: "high" },
		thinkingLevel: "medium",
		getEnabledToolNames: () => ["read", "ask"],
		getActiveToolNames: () => ["read", "ask"],
		getMountedXdevToolNames: () => ["read"],
		getAgentId: () => "Main",
		getMnemopiSessionState: () => MNEMOPI,
		...overrides,
	};
}

function fixture({ owner, manager, ...options } = {}) {
	const session = createOwner(owner);
	const sessionManager = createManager(manager);
	return {
		session,
		sessionManager,
		options: {
			session,
			flowId: "flow-a",
			sessionManager,
			asyncJobManager: ASYNC_JOBS,
			agentRegistry: AGENT_REGISTRY,
			...options,
		},
	};
}

function limitationCodes(result) {
	return result.limitations.map((limitation) => limitation.code);
}

describe("deriveFissionConfig", () => {
	test("rebuilds a complete flow config from the owner session", () => {
		const { options } = fixture();
		const result = deriveFissionConfig(options);
		expect(result.ok).toBe(true);
		const { config } = result;

		expect(config.cwd).toBe("/workspace");
		expect(config.costGate).toBe(COST_GATE);
		expect(config.sessionManager).toBe(options.sessionManager);
		expect(config.model).toBe(MODEL);
		expect(config.thinkingLevel).toBe("medium");
		expect(config.systemPrompt).toEqual(["owner prompt"]);
		expect(config.toolNames).toEqual(["read", "ask"]);
		expect(config.mountedToolNames).toEqual(["read"]);
		expect(config.advertiseHeadlessAsk).toBe(true);
		expect(config.providerSessionId).toBe("session-1");
		expect(config.providerPromptCacheKey).toBe("agent-cache");
		expect(config.taskPromptCacheKey).toBe("task-cache");
		expect(config.modelRegistry).toBe(MODEL_REGISTRY);
		expect(config.authStorage).toBe(AUTH_STORAGE);
		expect(config.settings).toBe(SETTINGS);
		expect(config.hasUI).toBe(false);
		expect(config.enableMCP).toBe(false);
		expect(config.enableLsp).toBe(false);
		expect(config.bindProcessState).toBe(false);
		expect(config.agentId).toBe("flow-a");
		expect(config.agentDisplayName).toBe("flow-a");
		expect(config.parentTaskPrefix).toBeUndefined();
		expect(config.asyncJobManager).toBe(ASYNC_JOBS);
		// A flow is a peer session, not a subagent: the host strips `todo` from
		// every subagent spawn, and one missing tool definition changes the whole
		// request head the provider cache is keyed on.
		expect(config.parentAgentId).toBeUndefined();
		expect(config.agentRegistry).toBe(AGENT_REGISTRY);
		expect(config.disableExtensionDiscovery).toBe(true);
		expect(config.preloadedPreparedExtensions).toEqual([PREPARED]);
		expect(config.preloadedExtensionPaths).toEqual([EXTENSION_PATH]);
		expect(config.parentMnemopiSessionState).toBe(MNEMOPI);
		expect(config.extensionRoots).toBeUndefined();
		expect(config.localProtocolOptions.getArtifactsDir()).toBe("/artifacts");
		expect(config.localProtocolOptions.getSessionId()).toBe("session-1");

		expect(limitationCodes(result)).toEqual([
			FISSION_SESSION_LIMITS.LSP_DISABLED,
			FISSION_SESSION_LIMITS.MCP_NOT_FOLLOWED,
			FISSION_SESSION_LIMITS.SETTINGS_SHARED,
			FISSION_SESSION_LIMITS.SHARED_MANAGER_DISPOSE_FORBIDDEN,
		]);
	});

	test("accepts the documented flow id characters and rejects the rest", () => {
		for (const flowId of ["flow-a", "A", "batch.0:child1", "x".repeat(128)]) {
			const result = deriveFissionConfig(fixture({ flowId }).options);
			expect(result.ok).toBe(true);
			expect(result.config.agentId).toBe(flowId);
		}
		for (const flowId of ["", "-leading", "has space", "x".repeat(129), null, 7]) {
			const result = deriveFissionConfig(fixture({ flowId }).options);
			expect(result.ok).toBe(false);
			expect(result.reason).toBe(FISSION_SESSION_REASONS.NO_FLOW_ID);
		}
	});

	test("takes the configured thinking level, then the live one, then the option", () => {
		const configured = deriveFissionConfig(fixture({ owner: { configuredThinkingLevel: () => "low" } }).options);
		expect(configured.config.thinkingLevel).toBe("low");

		const live = deriveFissionConfig(
			fixture({ owner: { agent: { thinkingLevel: "max" }, thinkingLevel: undefined } }).options,
		);
		expect(live.config.thinkingLevel).toBe("max");

		const overridden = deriveFissionConfig(fixture({ thinkingLevel: "off" }).options);
		expect(overridden.config.thinkingLevel).toBe("off");
	});

	test("derives the provider cache key from the agent, then the session", () => {
		const fromAgent = deriveFissionConfig(fixture().options).config;
		expect(fromAgent.providerPromptCacheKey).toBe("agent-cache");
		expect(fromAgent.taskPromptCacheKey).toBe("task-cache");

		// The manager already supplies a task key, so the provider key stays unset
		// instead of duplicating it.
		const fromTask = deriveFissionConfig(
			fixture({ owner: { agent: { thinkingLevel: "high" } } }).options,
		).config;
		expect(fromTask.providerPromptCacheKey).toBeUndefined();
		expect(fromTask.taskPromptCacheKey).toBe("task-cache");

		const fromSession = deriveFissionConfig(
			fixture({ owner: { agent: { thinkingLevel: "high" } }, manager: { getHeader: () => undefined } }).options,
		).config;
		expect(fromSession.providerPromptCacheKey).toBe("session-1");
		expect(fromSession.taskPromptCacheKey).toBeUndefined();
	});

	test("does not declare the flow a subagent of the owner", () => {
		// The owner id stays out of the config on purpose. `parentAgentId` marks
		// the session as a subagent, and the host then filters `todo` out of its
		// tool view; the flow's tool array would differ from the owner's by one
		// definition, which is enough to miss the provider cache at byte zero.
		expect(deriveFissionConfig(fixture().options).config.parentAgentId).toBeUndefined();
		expect(
			deriveFissionConfig(fixture({ owner: { getAgentId: () => "owner-7" } }).options).config.parentAgentId,
		).toBeUndefined();
	});

	test("uses the label as a display name without changing identity", () => {
		const labeled = deriveFissionConfig(fixture({ label: "batch.0/flow" }).options).config;
		expect(labeled.agentDisplayName).toBe("batch.0/flow");
		expect(labeled.agentId).toBe("flow-a");
		expect(labeled.parentTaskPrefix).toBeUndefined();
		expect(deriveFissionConfig(fixture({ label: "" }).options).config.agentDisplayName).toBe("flow-a");
	});

	test("copies the arrays it hands to the host", () => {
		const systemPrompt = ["owner prompt"];
		const toolNames = ["read", "ask"];
		const mountedToolNames = ["read"];
		const extensionPaths = [EXTENSION_PATH];
		const { options } = fixture({
			owner: {
				systemPrompt,
				getEnabledToolNames: () => toolNames,
				getActiveToolNames: () => toolNames,
				getMountedXdevToolNames: () => mountedToolNames,
				extensionPaths,
			},
		});
		const { config } = deriveFissionConfig(options);

		systemPrompt.push("late prompt");
		toolNames.push("write");
		mountedToolNames.push("grep");
		extensionPaths.push("/extensions/late.mjs");

		expect(config.systemPrompt).toEqual(["owner prompt"]);
		expect(config.toolNames).toEqual(["read", "ask"]);
		expect(config.mountedToolNames).toEqual(["read"]);
		expect(config.preloadedExtensionPaths).toEqual([EXTENSION_PATH]);
		expect(config.systemPrompt).not.toBe(systemPrompt);
		expect(config.toolNames).not.toBe(toolNames);
	});

	test("seeds extensions from prepared extensions first and otherwise from paths", () => {
		const preparedOnly = deriveFissionConfig(fixture({ owner: { extensionPaths: [] } }).options).config;
		expect(preparedOnly.preloadedPreparedExtensions).toEqual([PREPARED]);
		expect(preparedOnly.preloadedExtensionPaths).toBeUndefined();

		const pathsOnly = deriveFissionConfig(fixture({ owner: { preparedExtensions: [] } }).options).config;
		expect(pathsOnly.preloadedPreparedExtensions).toBeUndefined();
		expect(pathsOnly.preloadedExtensionPaths).toEqual([EXTENSION_PATH]);
	});

	test("exposes extension roots through a lazy reader when the owner has them", () => {
		const roots = ["/root-a"];
		const { config } = deriveFissionConfig(fixture({ owner: { effectiveExtensionRoots: roots } }).options);
		expect(config.extensionRoots()).toBe(roots);
	});

	test("advertises headless ask only when the active tool view contains it", () => {
		const withoutAsk = deriveFissionConfig(
			fixture({ owner: { getActiveToolNames: () => ["read"] } }).options,
		).config;
		expect(withoutAsk.advertiseHeadlessAsk).toBe(false);
		expect(withoutAsk.toolNames).toEqual(["read", "ask"]);
	});

	test("reads local protocol options live from the shared manager", () => {
		const { options, sessionManager } = fixture();
		const { config } = deriveFissionConfig(options);
		sessionManager.getArtifactsDir = () => "/artifacts-2";
		expect(config.localProtocolOptions.getArtifactsDir()).toBe("/artifacts-2");
	});

	test("names every known gap with a code and an explanation", () => {
		const { options } = fixture({
			owner: { getMnemopiSessionState: undefined },
			manager: { getArtifactsDir: undefined },
			asyncJobManager: undefined,
			agentRegistry: undefined,
		});
		const result = deriveFissionConfig(options);
		expect(result.ok).toBe(true);
		expect(result.config.asyncJobManager).toBe(ASYNC_JOBS);
		expect(result.config.localProtocolOptions).toBeUndefined();
		expect(result.config.parentMnemopiSessionState).toBeUndefined();
		expect(result.config.agentRegistry).toBeUndefined();
		expect(limitationCodes(result)).toEqual([
			FISSION_SESSION_LIMITS.STREAM_MANAGER_INHERITED,
			FISSION_SESSION_LIMITS.LOCAL_PROTOCOL_DEFAULT,
			FISSION_SESSION_LIMITS.MNEMOPI_ABSENT,
			FISSION_SESSION_LIMITS.GLOBAL_AGENT_REGISTRY,
			FISSION_SESSION_LIMITS.LSP_DISABLED,
			FISSION_SESSION_LIMITS.MCP_NOT_FOLLOWED,
			FISSION_SESSION_LIMITS.SETTINGS_SHARED,
			FISSION_SESSION_LIMITS.SHARED_MANAGER_DISPOSE_FORBIDDEN,
		]);
		for (const limitation of result.limitations) {
			expect(typeof limitation.code).toBe("string");
			expect(limitation.detail.length).toBeGreaterThan(20);
		}
	});

	test("carries the caller's MCP wiring when it is enabled", () => {
		const mcpManager = { kind: "mcpManager" };
		const mcpTools = [{ name: "mcp_tool" }];
		const result = deriveFissionConfig(
			fixture({ enableMCP: true, mcpManager, mcpTools, mcpToolScope: "session" }).options,
		);
		expect(result.config.enableMCP).toBe(true);
		expect(result.config.mcpManager).toBe(mcpManager);
		expect(result.config.mcpTools).toBe(mcpTools);
		expect(result.config.mcpToolScope).toBe("session");
		expect(limitationCodes(result)).not.toContain(FISSION_SESSION_LIMITS.MCP_NOT_FOLLOWED);
	});

	test("keeps the limitation list in step with a truthy non-boolean switch", () => {
		const lsp = deriveFissionConfig(fixture({ enableLsp: "yes" }).options);
		expect(lsp.config.enableLsp).toBe(false);
		expect(limitationCodes(lsp)).toContain(FISSION_SESSION_LIMITS.LSP_DISABLED);

		const mcp = deriveFissionConfig(fixture({ enableMCP: 1 }).options);
		expect(mcp.config.enableMCP).toBe(false);
		expect(limitationCodes(mcp)).toContain(FISSION_SESSION_LIMITS.MCP_NOT_FOLLOWED);

		const enabled = deriveFissionConfig(fixture({ enableLsp: true }).options);
		expect(enabled.config.enableLsp).toBe(true);
		expect(limitationCodes(enabled)).not.toContain(FISSION_SESSION_LIMITS.LSP_DISABLED);
	});

	test("reports the first condition it cannot rebuild", () => {
		const unbuildable = fixture();
		unbuildable.options.flowId = "bad id";
		unbuildable.options.sessionManager = null;
		unbuildable.options.session.model = undefined;
		expect(deriveFissionConfig(unbuildable.options).reason).toBe(FISSION_SESSION_REASONS.NO_FLOW_ID);

		const missingModel = fixture();
		missingModel.options.session.model = undefined;
		missingModel.options.session.modelRegistry = undefined;
		expect(deriveFissionConfig(missingModel.options).reason).toBe(FISSION_SESSION_REASONS.NO_MODEL);
	});

	test("treats a throwing owner or manager getter as an absent value", () => {
		const prompt = fixture();
		Object.defineProperty(prompt.options.session, "systemPrompt", {
			get() {
				throw new Error("systemPrompt exploded");
			},
		});
		expect(deriveFissionConfig(prompt.options).reason).toBe(FISSION_SESSION_REASONS.NO_SYSTEM_PROMPT);

		const cwd = fixture();
		cwd.options.sessionManager.getCwd = () => {
			throw new Error("getCwd exploded");
		};
		expect(deriveFissionConfig(cwd.options).reason).toBe(FISSION_SESSION_REASONS.NO_CWD);
	});
});

const REFUSALS = [
	["NO_OWNER", ({ options }) => { options.session = null; }],
	["NO_FLOW_ID", ({ options }) => { options.flowId = "flow a"; }],
	["NO_SESSION_MANAGER", ({ options }) => { options.sessionManager = null; }],
	["NO_ASYNC_JOB_MANAGER", ({ options }) => {
		options.session.asyncJobManager = undefined;
		options.asyncJobManager = undefined;
	}],
	["NO_COST_GATE", ({ options }) => { options.session.costGate = undefined; }],
	["NO_MODEL", ({ options }) => { options.session.model = undefined; }],
	["NO_MODEL_REGISTRY", ({ options }) => { options.session.modelRegistry = undefined; }],
	["NO_AUTH_STORAGE", ({ options }) => { options.session.modelRegistry = { authStorage: null }; }],
	["NO_SESSION_ID", ({ options }) => {
		options.session.sessionId = undefined;
		options.sessionManager.getSessionId = undefined;
	}],
	["NO_SETTINGS", ({ options }) => { options.session.settings = undefined; }],
	["NO_CWD", ({ options }) => { options.sessionManager.getCwd = undefined; }],
	["NO_SYSTEM_PROMPT", ({ options }) => { options.session.systemPrompt = "not an array"; }],
	["NO_TOOL_VIEW", ({ options }) => { options.session.getActiveToolNames = undefined; }],
	["NO_EXTENSION_SEED", ({ options }) => {
		options.session.preparedExtensions = [];
		options.session.extensionPaths = [];
	}],
];

for (const [reason, prepare] of REFUSALS) {
	test(`refuses with ${reason}`, () => {
		const current = fixture();
		prepare(current);
		const result = deriveFissionConfig(current.options);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(FISSION_SESSION_REASONS[reason]);
		expect(result.config).toBeUndefined();
		expect(result.detail.length).toBeGreaterThan(0);
	});
}

describe("createFissionSession", () => {
	test("returns the host session and its wiring", async () => {
		const { options } = fixture();
		const session = { id: "flow-session" };
		const eventBus = { id: "event-bus" };
		const extensionsResult = { extensions: [] };
		const received = [];
		const result = await createFissionSession({
			...options,
			createAgentSession: async (config) => {
				received.push(config);
				return { session, eventBus, extensionsResult };
			},
		});

		expect(result.ok).toBe(true);
		expect(received).toHaveLength(1);
		expect(received[0]).toBe(result.config);
		expect(result.session).toBe(session);
		expect(result.eventBus).toBe(eventBus);
		expect(result.extensionsResult).toBe(extensionsResult);
		expect(result.config.agentId).toBe("flow-a");
	});

	test("refuses when construction throws and keeps the error", async () => {
		const { options } = fixture();
		const failure = new Error("host exploded");
		const result = await createFissionSession({
			...options,
			createAgentSession: async () => {
				throw failure;
			},
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe(FISSION_SESSION_REASONS.CREATE_FAILED);
		expect(result.error).toBe(failure);
		expect(result.config.agentId).toBe("flow-a");
		expect(result.limitations.length).toBeGreaterThan(0);
		expect(result.detail.length).toBeGreaterThan(0);
	});

	test("refuses a factory that returns no session object", async () => {
		for (const created of [undefined, null, {}, { session: null }, { session: "not a session" }]) {
			const { options } = fixture();
			const result = await createFissionSession({
				...options,
				createAgentSession: async () => created,
			});
			expect(result.ok).toBe(false);
			expect(result.reason).toBe(FISSION_SESSION_REASONS.CREATE_RETURNED_NOTHING);
			expect(result.config.agentId).toBe("flow-a");
		}
	});

	test("never builds a factory when the derivation is refused", async () => {
		const { options } = fixture();
		options.flowId = "bad id";
		let called = false;
		const result = await createFissionSession({
			...options,
			createAgentSession: () => {
				called = true;
				return { session: {} };
			},
		});
		expect(result.reason).toBe(FISSION_SESSION_REASONS.NO_FLOW_ID);
		expect(called).toBe(false);
	});

	test("refuses when no host factory is available", async () => {
		const { options } = fixture();
		const result = await createFissionSession({ ...options, createAgentSession: 42 });
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(FISSION_SESSION_REASONS.NO_SDK);
		expect(result.config.agentId).toBe("flow-a");
		expect(result.detail.length).toBeGreaterThan(0);
	});
});
