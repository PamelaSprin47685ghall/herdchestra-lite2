import { describe, expect, test } from "bun:test";

import {
	FISSION_MANAGER,
	isFissionManager,
} from "../src/host/fission-manager.mjs";
import {
	FISSION_SESSION_LIMITS,
	createFissionSession,
} from "../src/host/fission-session.mjs";
import { createStationRegistry } from "../src/station/registry.mjs";

// A shared manager double that mirrors the host facts the flow proxies rely
// on: one global leaf, plain appends that follow it, off-branch appends that
// never move it, and terminal seal/close arriving through whatever object the
// caller was handed.
function makeShared() {
	const entries = [];
	const calls = { seal: 0, close: 0, release: 0 };
	let leaf = null;
	let sequence = 0;
	const nextId = () => `e${(sequence += 1).toString(16).padStart(3, "0")}`;
	const append = (fields) => {
		const entry = { id: nextId(), parentId: leaf, ...fields };
		entries.push(entry);
		leaf = entry.id;
		return entry.id;
	};

	const shared = {
		entries,
		calls,
		getLeafId: () => leaf,
		getSessionId: () => "session-1",
		getCwd: () => "/workspace",
		getHeader: () => undefined,
		getArtifactsDir: () => "/artifacts",
		getBranch: (fromId) => {
			let current = fromId === undefined ? leaf : fromId;
			const branch = [];
			while (current != null) {
				const entry = entries.find((candidate) => candidate.id === current);
				if (!entry) throw new Error(`missing entry ${current}`);
				branch.unshift(entry);
				current = entry.parentId;
			}
			return branch;
		},
		getEntry: (id) => entries.find((entry) => entry.id === id),
		getEntries: () => entries.slice(),
		branch: (id) => {
			if (!entries.some((entry) => entry.id === id)) throw new Error(`Entry ${id} not found`);
			leaf = id;
		},
		resetLeaf: () => {
			leaf = null;
		},
		appendMessage: (message) => append({ type: "message", message }),
		appendMessageToBranch: (message, parentId) => {
			const id = nextId();
			entries.push({ id, parentId, type: "message", message, activeLeafId: leaf });
			return id;
		},
		appendModelUsage: (usage, owner) => {
			const id = nextId();
			entries.push({ id, parentId: owner.parentId, type: "model_usage", usage, sessionId: owner.sessionId });
			if (owner.parentId === leaf) leaf = id;
			return id;
		},
		appendCustomEntry: (customType, data) => append({ type: "custom", customType, data }),
		appendCustomMessageEntry: (customType, content) => append({ type: "custom_message", customType, content }),
		appendModelChange: (...args) => append({ type: "model_change", args }),
		branchWithSummary: (fromId, summary, details) => append({ type: "branch_summary", fromId, summary, details }),
		buildSessionContext: () => ({ leafId: leaf, branch: shared.getBranch() }),
		getCredentialPins: () => [],
		setSessionName: (name) => {
			append({ type: "title_change", name });
			return Promise.resolve("saved");
		},
		seal: () => {
			calls.seal += 1;
		},
		close: () => {
			calls.close += 1;
			return Promise.resolve("closed");
		},
		releaseRetainedEntries: () => {
			calls.release += 1;
		},
	};
	return shared;
}

function owner() {
	return {
		asyncJobManager: { kind: "asyncJobManager" },
		costGate: { kind: "costGate" },
		model: { id: "model-1" },
		modelRegistry: { authStorage: { kind: "authStorage" } },
		sessionId: "session-1",
		settings: { kind: "settings" },
		systemPrompt: ["owner prompt"],
		preparedExtensions: [{ name: "prepared" }],
		extensionPaths: ["/extensions/base.mjs"],
		agent: {},
		getEnabledToolNames: () => ["read"],
		getActiveToolNames: () => ["read"],
		getMountedXdevToolNames: () => [],
		getAgentId: () => "Main",
	};
}

function spawnSession(shared, flowId, label) {
	return createFissionSession({
		session: owner(),
		sessionManager: shared,
		flowId,
		label,
		createAgentSession: async (config) => ({ session: { agentId: config.agentId } }),
	});
}

describe("createFissionSession manager wiring", () => {
	test("gives the flow a proxy and writes below its begin entry", async () => {
		const shared = makeShared();
		const root = shared.appendMessage({ role: "user", content: "root" });
		const created = await spawnSession(shared, "flow-a", "b1.0");
		expect(created.ok).toBe(true);

		const manager = created.config.sessionManager;
		expect(isFissionManager(manager)).toBe(true);
		expect(manager[FISSION_MANAGER]).toBe(true);
		expect(created.limitations.map((limit) => limit.code)).not.toContain(
			FISSION_SESSION_LIMITS.SHARED_MANAGER_NOT_PROXIED,
		);

		// The scheduler writes the flow boundaries through the raw manager; the
		// proxy must continue from them rather than from its creation anchor.
		shared.branch(root);
		shared.appendCustomEntry("scope.begin", { flow: "b1.0" });
		const end = shared.appendCustomEntry("scope.end", {});
		const message = manager.appendMessage({ role: "assistant", content: "flow" });
		expect(shared.getLeafId()).toBe(end);
		expect(shared.getEntry(message).parentId).toBe(end);
		expect(manager.getBranch().map((entry) => entry.id).slice(-2)).toEqual([end, message]);
	});

	test("keeps sibling flows on separate branches and survives one dispose", async () => {
		const shared = makeShared();
		const root = shared.appendMessage({ role: "user", content: "root" });
		const a = await spawnSession(shared, "flow-a", "b1.0");
		const b = await spawnSession(shared, "flow-b", "b1.1");

		shared.branch(root);
		shared.appendCustomEntry("scope.begin", { flow: "b1.0" });
		shared.branch(root);
		shared.appendCustomEntry("scope.begin", { flow: "b1.1" });

		const aMessage = a.config.sessionManager.appendMessage({ role: "assistant", content: "a" });
		const bMessage = b.config.sessionManager.appendMessage({ role: "assistant", content: "b" });
		expect(a.config.sessionManager.getBranch().map((entry) => entry.id)).not.toContain(bMessage);
		expect(b.config.sessionManager.getBranch().map((entry) => entry.id)).not.toContain(aMessage);

		// One flow's disposal drops only its lease; the session lease keeps the
		// shared manager open for its sibling.
		await a.config.sessionManager.close();
		expect(shared.calls.seal).toBe(0);
		expect(shared.calls.close).toBe(0);
		const again = b.config.sessionManager.appendMessage({ role: "assistant", content: "b2" });
		expect(shared.getEntry(again).parentId).toBe(bMessage);
	});

	test("reports a manager without the leaf contract instead of pretending", async () => {
		const manager = { getSessionId: () => "session-1", getCwd: () => "/workspace" };
		const created = await createFissionSession({
			session: owner(),
			sessionManager: manager,
			flowId: "flow-a",
			createAgentSession: async () => ({ session: {} }),
		});
		expect(created.ok).toBe(true);
		expect(created.config.sessionManager).toBe(manager);
		expect(created.limitations.map((limit) => limit.code)).toContain(
			FISSION_SESSION_LIMITS.SHARED_MANAGER_NOT_PROXIED,
		);
	});
});

describe("station registry proxy adoption", () => {
	test("routes the flow station through the proxy its session was given", async () => {
		const shared = makeShared();
		shared.appendMessage({ role: "user", content: "root" });
		const created = await spawnSession(shared, "flow-a", "b1.0");
		const registry = createStationRegistry(null);
		const station = { manager: shared };

		const entry = registry.bindFlow("flow-a", station, "ro", {
			batchId: "b1",
			index: 0,
			label: "b1.0",
			manager: shared,
		});

		expect(station.manager).toBe(created.config.sessionManager);
		expect(isFissionManager(station.manager)).toBe(true);
		expect(entry.manager).toBe(created.config.sessionManager);
		registry.unbindFlow("flow-a");
	});

	test("a failed construction releases only its own lease", async () => {
		const shared = makeShared();
		shared.appendMessage({ role: "user", content: "root" });
		const good = await spawnSession(shared, "flow-a", "b1.0");
		const failed = await createFissionSession({
			session: owner(),
			sessionManager: shared,
			flowId: "flow-b",
			label: "b1.1",
			createAgentSession: async () => {
				throw new Error("host exploded");
			},
		});

		expect(failed.ok).toBe(false);
		expect(failed.reason).toBe("CREATE_FAILED");
		expect(shared.calls.seal).toBe(0);
		expect(shared.calls.close).toBe(0);

		shared.appendCustomEntry("scope.begin", { flow: "b1.0" });
		const written = good.config.sessionManager.appendMessage({ role: "assistant", content: "alive" });
		expect(shared.getEntry(written).parentId).not.toBeNull();
	});
});
