import { describe, expect, test } from "bun:test";
import { createFissionAgentRegistry } from "../src/host/fission-registry.mjs";
import { createFissionSession, FISSION_SESSION_LIMITS } from "../src/host/fission-session.mjs";

function makeMockRegistry() {
	const refs = new Map();
	const events = [];
	const awaitsHeld = [];
	let generation = 0;

	return {
		events,
		awaitsHeld,
		awaits: {
			hold(waiterId, targets, options) {
				awaitsHeld.push({ waiterId, targets, options });
				return () => {};
			},
		},
		register(input) {
			generation += 1;
			const ref = { ...input, generation };
			refs.set(input.id, ref);
			events.push({ type: "registered", ref });
			return ref;
		},
		registerIfAvailable(input, expected) {
			const current = refs.get(input.id);
			if (expected === null && current) return undefined;
			if (expected !== null && current !== expected) return undefined;
			return this.register(input);
		},
		get(id) {
			return refs.get(id);
		},
		list() {
			return [...refs.values()];
		},
		listVisibleTo(id) {
			return [...refs.values()].filter((r) => r.id !== id && r.kind !== "advisor");
		},
		setStatus(id, status) {
			const ref = refs.get(id);
			if (!ref) return false;
			ref.status = status;
			events.push({ type: "status_changed", ref });
			return true;
		},
		unregister(id) {
			const ref = refs.get(id);
			if (!ref) return false;
			refs.delete(id);
			events.push({ type: "removed", ref });
			return true;
		},
		onChange(listener) {
			return () => {};
		},
	};
}

describe("createFissionAgentRegistry", () => {
	test("keeps flowId registration completely private and never pollutes baseRegistry", () => {
		const base = makeMockRegistry();
		base.register({ id: "Main", displayName: "Main", kind: "main", status: "running", session: null });
		base.register({ id: "TaskAlpha", displayName: "TaskAlpha", kind: "sub", parentId: "Main", status: "running", session: null });
		base.events.length = 0;

		const scoped = createFissionAgentRegistry({
			baseRegistry: base,
			flowId: "bcall1x1.0",
			ownerAgentId: "TaskAlpha",
		});

		const flowRef = scoped.register({
			id: "bcall1x1.0",
			displayName: "flow-0",
			kind: "sub",
			parentId: "TaskAlpha",
			status: "running",
			session: null,
		});

		expect(flowRef.id).toBe("bcall1x1.0");
		expect(scoped.get("bcall1x1.0")).toBe(flowRef);
		expect(base.get("bcall1x1.0")).toBeUndefined();
		expect(base.list().map((r) => r.id)).toEqual(["Main", "TaskAlpha"]);
		expect(base.events).toEqual([]);

		expect(scoped.setStatus("bcall1x1.0", "idle", flowRef)).toBe(true);
		expect(scoped.get("bcall1x1.0").status).toBe("idle");
		expect(base.events).toEqual([]);

		expect(scoped.unregister("bcall1x1.0", flowRef)).toBe(true);
		expect(scoped.get("bcall1x1.0")).toBeUndefined();
		expect(base.events).toEqual([]);
	});

	test("forwards real child task registration to baseRegistry and rewrites parentId from flowId to ownerAgentId", () => {
		const base = makeMockRegistry();
		base.register({ id: "Main", displayName: "Main", kind: "main", status: "running", session: null });
		base.register({ id: "TaskAlpha", displayName: "TaskAlpha", kind: "sub", parentId: "Main", status: "running", session: null });

		const scoped = createFissionAgentRegistry({
			baseRegistry: base,
			flowId: "bcall1x1.0",
			ownerAgentId: "TaskAlpha",
		});

		const childRef = scoped.register({
			id: "ChildTask",
			displayName: "ChildTask",
			kind: "sub",
			parentId: "bcall1x1.0",
			status: "running",
			session: null,
		});

		expect(childRef.parentId).toBe("TaskAlpha");
		expect(base.get("ChildTask")?.parentId).toBe("TaskAlpha");
		expect(scoped.listVisibleTo("bcall1x1.0").map((r) => r.id)).toEqual(["Main", "ChildTask"]);

		scoped.awaits.hold("bcall1x1.0", ["ChildTask"]);
		expect(base.awaitsHeld[0].waiterId).toBe("TaskAlpha");
	});
});

describe("createFissionSession isolated agentRegistry default", () => {
	test("injects an isolated agentRegistry by default so flowId does not register in baseRegistry", async () => {
		const base = makeMockRegistry();
		let receivedConfig = null;
		const owner = {
			cwd: "/tmp/test",
			costGate: {},
			sessionId: "sess-1",
			sessionManager: { getHeader: () => ({}), getArtifactsDir: () => null, getSessionId: () => "sess-1" },
			model: { provider: "test", id: "m1" },
			modelRegistry: { authStorage: {} },
			settings: {},
			asyncJobManager: {},
			systemPrompt: [{ role: "system", content: "hi" }],
			getEnabledToolNames: () => ["read"],
			getActiveToolNames: () => ["read"],
			getMountedXdevToolNames: () => [],
			extensionPaths: ["/tmp/ext.mjs"],
			getAgentId: () => "TaskAlpha",
		};

		const result = await createFissionSession({
			session: owner,
			sessionManager: owner.sessionManager,
			cwd: owner.cwd,
			flowId: "bcall2x1.0",
			baseAgentRegistry: base,
			createAgentSession: async (cfg) => {
				receivedConfig = cfg;
				cfg.agentRegistry.register({ id: cfg.agentId, displayName: cfg.agentDisplayName, kind: "sub", status: "running", session: null });
				return { session: { id: "flow-session" } };
			},
		});

		expect(result.ok).toBe(true);
		expect(receivedConfig.agentRegistry).toBeDefined();
		expect(base.get("bcall2x1.0")).toBeUndefined();
		expect(result.limitations.some((l) => l.code === FISSION_SESSION_LIMITS.GLOBAL_AGENT_REGISTRY)).toBe(false);
	});
});
