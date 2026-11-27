// Acceptance tests for immutable-context decoupling:
// 1. Cross-branch spy subscopes (running upscope, done upscope, restored ledger)
// 2. Fail-closed paths, duplicates, unknown/unready upscopes
// 3. Global directory delta sparsity, retry idempotency, and baseline resets
// 4. Graceful scope_abandon (single-scope interrupt, ABANDONED mode, no rewind,
//    idempotency, root/self refusal, orphan reparenting, forced close fallback)

import { describe, expect, test } from "bun:test";

import { SessionStation } from "../src/station/station.mjs";
import { createForkWiring } from "../src/wiring/fork-wiring.mjs";
import { buildPorts } from "../src/core/ports/build.mjs";
import { createStationRegistry } from "../src/station/registry.mjs";
import {
	createBracketLedger,
	forkOf,
	markReady,
	registerFork,
	restoreLedgerChecked,
	serializeLedger,
	updateRecordSnapshot,
	updateRootMeta,
} from "../src/scope/forkjoin.mjs";
import { diffDirectory, projectDirectory } from "../src/scope/directory.mjs";
import { findScopeByPath, normalizeScopePath } from "../src/scope/path.mjs";
import { closedLeafId, isClosedSnapshotBranch } from "../src/station/domain/snapshot-leaf.mjs";
import { spawnChildTicket } from "../src/tools/spawn-ticket.mjs";
import { handleForkCall, handleJoinCall, handleReturnCall } from "../src/station/fork-controls.mjs";
import { handleAbandonCall } from "../src/station/abandon-controls.mjs";
import { RETURN_OATH_KEY } from "../src/station/domain/handoff.mjs";
import { createBranchSession } from "../host-omp/src/host/branch-session.mjs";

function makeManager(id = "session-1") {
	return {
		getSessionId: () => id,
		getLeafId: () => "leaf-root-1",
		getBranch: () => [
			{ id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ id: "leaf-root-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
		],
		appendCustomEntry: () => "custom-1",
		appendMessage: () => "msg-1",
		buildSessionContext: () => ({ messages: [] }),
	};
}

function makeStation({ manager = makeManager(), wiring = createForkWiring(), identity = null } = {}) {
	const tickets = {
		canSteer: true,
		canPrompt: true,
		steer: () => true,
		prompt: () => true,
	};
	const built = buildPorts();
	const registry = createStationRegistry({
		tickets,
		ports: built.names,
		implementations: built.implementations,
		features: built.features,
	});
	const station = new SessionStation(manager, {}, tickets, registry);
	wiring.attach(station, { conversationKey: manager.getSessionId(), identity });
	return { station, wiring };
}

describe("decoupled upscope / caller & spy subscopes", () => {
	test("cross-branch spy inherits upscope snapshot, model, and context admission, but delivers to caller", () => {
		const wiring = createForkWiring();
		const { station: root } = makeStation({ wiring });
		const spawned = [];
		root.childSpawnPort = () => (spec) => {
			spawned.push(spec);
			return true;
		};
		const models = {
			resolve: (sel) => {
				if (sel.startsWith("anthropic/claude-opus-4-5")) {
					return { provider: "anthropic", id: "claude-opus-4-5", contextWindow: 200_000 };
				}
				return null;
			},
			list: () => [{ provider: "anthropic", id: "claude-opus-4-5", contextWindow: 200_000 }],
		};
		root.host = {
			...root.host,
			model: {
				...root.host.model,
				query: () => models,
			},
		};

		// Register /api and /ui from Root
		const r1 = handleForkCall(root, {
			id: "call-1",
			arguments: {
				forks: [
					{
						path: "inspector.api",
						fsm: "build api",
						profession: "You are an API engineer.",
						n: 3,
						budget: { read: 2 },
						targets: ["src/api.mjs"],
						model: "anthropic/claude-opus-4-5:high",
					},
					{
						path: "inspector.ui",
						fsm: "build ui",
						profession: "You are a UI engineer.",
						n: 3,
						budget: { read: 2 },
						targets: ["src/ui.mjs"],
					},
				],
			},
		});
		expect(r1.isError).toBeUndefined();
		const ledger = root.forkLedgerPort();
		const apiRec = findScopeByPath(ledger, "/inspector.api");
		const uiRec = findScopeByPath(ledger, "/inspector.ui");
		expect(apiRec).toBeTruthy();
		expect(uiRec).toBeTruthy();

		// Simulate /api having completed a closed turn with snapshot leaf + 195k context
		updateRecordSnapshot(ledger, apiRec.forkId, {
			safeSnapshotLeafId: "api-closed-leaf-4",
			snapshotContextTokens: 195_000,
		});

		// Build /ui station (caller is /ui, /ui itself is tiny at 10k)
		const { station: uiStation } = makeStation({
			wiring,
			identity: { forkId: uiRec.forkId, ledger, childDepth: uiRec.childDepth },
		});
		uiStation.childSpawnPort = () => (spec) => {
			spawned.push(spec);
			return true;
		};
		uiStation.host = root.host;
		uiStation.usage.lastTotalInput = 10_000;

		// /ui tries to fork /api/spy — /api is at 195k/200k so admission MUST refuse FORK_CONTEXT_EXCEEDED
		const refused = handleForkCall(uiStation, {
			id: "call-2",
			arguments: {
				forks: [
					{
						path: "/inspector.api/inspector.spy",
						fsm: "inspect api",
						profession: "You are a spy.",
						n: 1,
						budget: {},
						targets: ["check api state"],
					},
				],
			},
		});
		expect(refused.isError).toBe(true);
		expect(refused.details.code).toBe("FORK_CONTEXT_EXCEEDED");

		// Now /api is at 40k/200k; /ui forks /api/spy omitting model -> inherits /api's model + thinking
		updateRecordSnapshot(ledger, apiRec.forkId, { snapshotContextTokens: 40_000 });
		const okSpy = handleForkCall(uiStation, {
			id: "call-3",
			arguments: {
				forks: [
					{
						path: "/inspector.api/inspector.spy",
						fsm: "inspect api",
						profession: "You are a spy.",
						n: 1,
						budget: {},
						targets: ["check api state"],
					},
				],
			},
		});
		expect(okSpy.isError).toBeUndefined();
		expect(okSpy.details.result.started[0]).toMatchObject({
			path: "/inspector.api/inspector.spy",
			upscope: "/inspector.api",
		});

		const spySpec = spawned.at(-1);
		expect(spySpec.upscopePath).toBe("/inspector.api");
		expect(spySpec.callerPath).toBe("/inspector.ui");
		expect(spySpec.upscopeSnapshotLeafId).toBe("api-closed-leaf-4");
		expect(spySpec.sourceToolCallId).toBeNull();
		expect(spySpec.model).toBe("anthropic/claude-opus-4-5");
		expect(spySpec.thinkingLevel).toBe("high");
		expect(spySpec.receipt).toContain("upscope /inspector.api, caller /inspector.ui");
		expect(spySpec.receipt).toContain("does not share /inspector.api's context");

		// /api/spy returns -> delivers to /ui (caller), NOT /api!
		const spyRec = findScopeByPath(ledger, "/inspector.api/inspector.spy");
		const { station: spyStation } = makeStation({
			wiring,
			identity: { forkId: spyRec.forkId, ledger, childDepth: spyRec.childDepth },
		});
		const ret = handleReturnCall(spyStation, {
			id: "ret-spy",
			arguments: {
				dafny: "API endpoint is /v2/users",
				[RETURN_OATH_KEY]: "a_ferocious_audacious_master_would_change_nothing",
			},
		});
		expect(ret.isError).toBeUndefined();
		expect(ret.details.receiver).toBe(uiRec.forkId);

		// /ui joins /api/spy directly
		const joined = handleJoinCall(uiStation, { id: "join-ui" });
		expect(joined.isError).toBeUndefined();
		expect(joined.details.result.scope).toBe("/inspector.api/inspector.spy");
		expect(joined.details.result.record).toContain("API endpoint is /v2/users");
		// /api was never interrupted
		expect(apiRec.status).toBe("running");
	});

	test("createBranchSession validates upscopeSnapshotLeafId and rejects dangling toolCall", async () => {
		const entries = [
			{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
			{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "js", arguments: {} }] } },
		];
		expect(closedLeafId(entries)).toBe("u1");
		expect(isClosedSnapshotBranch(entries)).toBe(false);
		expect(isClosedSnapshotBranch(entries.slice(0, 1))).toBe(true);

		const fakeShared = {
			getSessionId: () => "s1",
			getLeafId: () => "a1",
			getCwd: () => "/tmp",
			getHeader: () => ({}),
			getArtifactsDir: () => "/tmp",
			getBranch: (fromId) => {
				if (fromId === "a1") return entries;
				if (fromId === "u1") return entries.slice(0, 1);
				return entries;
			},
			getEntry: (id) => entries.find((e) => e.id === id) ?? null,
			branch: () => {},
			resetLeaf: () => {},
			seal: () => {},
			close: () => {},
		};
		const owner = {
			sessionId: "s1",
			asyncJobManager: {},
			costGate: {},
			model: { provider: "anthropic", id: "claude-opus-4-5" },
			modelRegistry: { authStorage: {} },
			settings: {},
			systemPrompt: ["sys"],
			getEnabledToolNames: () => ["js"],
			getActiveToolNames: () => ["js"],
			getMountedToolCommandNames: () => [],
			preparedExtensions: [{}],
		};

		const unsafe = await createBranchSession({
			session: owner,
			sessionManager: fakeShared,
			flowId: "spy-1",
			upscopeSnapshotLeafId: "a1",
		});
		expect(unsafe.ok).toBe(false);
		expect(unsafe.reason).toBe("UPSCOPE_SNAPSHOT_UNSAFE");

		const missing = await createBranchSession({
			session: owner,
			sessionManager: fakeShared,
			flowId: "spy-2",
			upscopeSnapshotLeafId: "nonexistent",
		});
		expect(missing.ok).toBe(false);
		expect(missing.reason).toBe("NO_UPSCOPE_SNAPSHOT");
	});
});

describe("fail-closed paths & duplicates", () => {
	test("normalizeScopePath refuses .. past /, trailing slash, //, wildcards, root segment", () => {
		expect(normalizeScopePath("/inspector.api", "../..").ok).toBe(false);
		expect(normalizeScopePath("/", "..").ok).toBe(false);
		expect(normalizeScopePath("/", "/api/").ok).toBe(false);
		expect(normalizeScopePath("/", "/inspector.api//inspector.spy").ok).toBe(false);
		expect(normalizeScopePath("/", "/api/*").ok).toBe(false);
		expect(normalizeScopePath("/", "/root").ok).toBe(false);
		expect(normalizeScopePath("/", "/Root/a").ok).toBe(false);
		expect(normalizeScopePath("/inspector.api", "../inspector.ui/inspector.spy")).toEqual({
			ok: true,
			path: "/inspector.ui/inspector.spy",
			isGlob: false,
		});
	});

	test("handleForkCall fails closed on duplicate running/done path, case mismatch, same-batch collision, unknown/unready upscope", () => {
		const wiring = createForkWiring();
		const { station: root } = makeStation({ wiring });
		root.childSpawnPort = () => () => true;

		const first = handleForkCall(root, {
			id: "c1",
			arguments: {
				forks: [{ path: "inspector.api", fsm: "api", profession: "You are API.", n: 1, budget: {}, targets: ["api"] }],
			},
		});
		expect(first.isError).toBeUndefined();
		const ledger = root.forkLedgerPort();
		const api = findScopeByPath(ledger, "/inspector.api");

		// Duplicate running path (case-insensitive)
		const dupRunning = handleForkCall(root, {
			id: "c2",
			arguments: {
				forks: [{ path: "/inspector.API", fsm: "api2", profession: "You are API.", n: 1, budget: {}, targets: ["api"] }],
			},
		});
		expect(dupRunning.isError).toBe(true);
		expect(dupRunning.details.code).toBe("DUPLICATE_SCOPE_PATH");

		// Unready upscope (safeSnapshotLeafId is still null)
		const unready = handleForkCall(root, {
			id: "c3",
			arguments: {
				forks: [{ path: "/inspector.api/inspector.spy", fsm: "spy", profession: "You are Spy.", n: 1, budget: {}, targets: ["spy"] }],
			},
		});
		expect(unready.isError).toBe(true);
		expect(unready.details.code).toBe("UPSCOPE_NOT_READY");

		// Unknown upscope
		const unknown = handleForkCall(root, {
			id: "c4",
			arguments: {
				forks: [{ path: "/inspector.missing/inspector.spy", fsm: "spy", profession: "You are Spy.", n: 1, budget: {}, targets: ["spy"] }],
			},
		});
		expect(unknown.isError).toBe(true);
		expect(unknown.details.code).toBe("UNKNOWN_UPSCOPE");

		// Same-batch sibling as upscope
		const batchUpscope = handleForkCall(root, {
			id: "c5",
			arguments: {
				forks: [
					{ path: "/inspector.ui", fsm: "ui", profession: "You are UI.", n: 1, budget: {}, targets: ["ui"] },
					{ path: "/inspector.ui/inspector.spy", fsm: "spy", profession: "You are Spy.", n: 1, budget: {}, targets: ["spy"] },
				],
			},
		});
		expect(batchUpscope.isError).toBe(true);
		expect(batchUpscope.details.code).toBe("UNKNOWN_UPSCOPE");

		// Same-batch duplicate path
		const batchDup = handleForkCall(root, {
			id: "c6",
			arguments: {
				forks: [
					{ path: "/inspector.ui", fsm: "ui", profession: "You are UI.", n: 1, budget: {}, targets: ["ui"] },
					{ path: "/inspector.UI", fsm: "ui2", profession: "You are UI.", n: 1, budget: {}, targets: ["ui"] },
				],
			},
		});
		expect(batchDup.isError).toBe(true);
		expect(batchDup.details.code).toBe("DUPLICATE_SCOPE_PATH");

		// Mark /api done, then confirm /api still blocks duplicate path & supports spy after restore
		updateRecordSnapshot(ledger, api.forkId, { safeSnapshotLeafId: "api-done-leaf", snapshotContextTokens: 25_000 });
		markReady(ledger, api.forkId, { ok: true, record: "done" });
		const dupDone = handleForkCall(root, {
			id: "c7",
			arguments: {
				forks: [{ path: "/inspector.api", fsm: "api3", profession: "You are API.", n: 1, budget: {}, targets: ["api"] }],
			},
		});
		expect(dupDone.isError).toBe(true);
		expect(dupDone.details.code).toBe("DUPLICATE_SCOPE_PATH");

		// Simulate resume / restoreLedgerChecked: done scope remains forkable as upscope
		const restored = restoreLedgerChecked(serializeLedger(ledger));
		expect(restored.ok).toBe(true);
		const restoredApi = findScopeByPath(restored.ledger, "/inspector.api");
		expect(restoredApi.safeSnapshotLeafId).toBe("api-done-leaf");
	});
});

describe("directory delta sparsity & resets", () => {
	test("running token changes produce 0 delta; done emits 1 exact line; reset re-emits baseline", () => {
		const ledger = createBracketLedger();
		updateRootMeta(ledger, {
			model: "anthropic/claude-opus-4-5",
			thinkingLevel: "high",
			dirContextTokens: 12_000,
			contextWindow: 200_000,
		});
		registerFork(ledger, {
			forkId: "f1",
			scopeId: "inspector.api",
			path: "/inspector.api",
			upscopePath: "/",
			ownerId: "root",
			callerPath: "/",
			fsm: "api",
			depth: 0,
			birthContextTokens: 12_000,
			contextWindow: 200_000,
			resolvedModel: "anthropic/claude-opus-4-5",
			resolvedThinking: "high",
		});

		const dir1 = projectDirectory(ledger);
		expect(dir1.get("/")).toBe("running | anthropic/claude-opus-4-5:high | 12k+ / 200k");
		expect(dir1.get("/inspector.api")).toBe("running | anthropic/claude-opus-4-5:high | 12k+ / 200k");

		// Live token updates on running /api do NOT change directory
		updateRecordSnapshot(ledger, "f1", { snapshotContextTokens: 42_000 });
		const dir2 = projectDirectory(ledger);
		expect(diffDirectory(dir1, dir2)).toBeNull();

		// Marking /api ready transitions it to done with exact 42k / 200k
		markReady(ledger, "f1", { ok: true, record: "done" });
		const dir3 = projectDirectory(ledger);
		expect(diffDirectory(dir2, dir3)).toEqual({
			"/inspector.api": "done | anthropic/claude-opus-4-5:high | 42k / 200k",
		});
	});
});

describe("graceful scope_abandon", () => {
	test("refuses root and self, is idempotent, forces ABANDONED scope_return without rewind, and reparents orphans", async () => {
		const wiring = createForkWiring();
		const { station: root } = makeStation({ wiring });
		let interruptedCount = 0;
		root.interruptScopePort = () => {
			interruptedCount += 1;
		};
		const ledger = root.forkLedgerPort();
		registerFork(ledger, {
			forkId: "f-api",
			scopeId: "inspector.api",
			path: "/inspector.api",
			upscopePath: "/",
			ownerId: "root",
			callerPath: "/",
			fsm: "api",
			depth: 0,
		});
		registerFork(ledger, {
			forkId: "f-sub",
			scopeId: "inspector.sub",
			path: "/inspector.api/inspector.sub",
			upscopeId: "f-api",
			upscopePath: "/inspector.api",
			ownerId: "f-api",
			callerPath: "/inspector.api",
			fsm: "sub",
			depth: 1,
		});

		// Cannot abandon root
		const abRoot = handleAbandonCall(root, { id: "a0", arguments: { target: "/" } });
		expect(abRoot.isError).toBe(true);
		expect(abRoot.details.code).toBe("CANNOT_ABANDON_ROOT");

		// Cannot abandon self
		const { station: apiStation } = makeStation({
			wiring,
			identity: { forkId: "f-api", ledger, childDepth: 1 },
		});
		const abSelf = handleAbandonCall(apiStation, { id: "a1", arguments: { target: "." } });
		expect(abSelf.isError).toBe(true);
		expect(abSelf.details.code).toBe("CANNOT_ABANDON_SELF");

		// Abandon /api from Root
		const ab1 = handleAbandonCall(root, {
			id: "a2",
			arguments: { target: "/inspector.api", reason: "pivot to v2" },
		});
		expect(ab1.isError).toBeUndefined();
		expect(ab1.details.result).toEqual({ ok: true, target: "/inspector.api" });
		expect(interruptedCount).toBe(1);
		expect(forkOf(ledger, "f-api").status).toBe("running");

		// Repeat abandon is idempotent (no second interrupt)
		const ab2 = handleAbandonCall(root, {
			id: "a3",
			arguments: { target: "/inspector.api", reason: "again" },
		});
		expect(ab2.isError).toBeUndefined();
		expect(ab2.details.result.alreadyAbandoning).toBe(true);
		expect(interruptedCount).toBe(1);

		// /api projection is now ABANDONED with only scope_return bound
		const cap = apiStation.projectionFor({});
		expect(cap.mode).toBe("ABANDONED");
		expect(cap.tools).toEqual(["scope_return"]);
		expect(cap.state.abandoned).toEqual({ by: "/", reason: "pivot to v2" });

		// Abandoned /api calls scope_return with oath="unfinished" -> NO rewind, immediate deliver, orphans reparented to Root!
		const ret = handleReturnCall(apiStation, {
			id: "r1",
			arguments: {
				dafny: "partial findings",
				[RETURN_OATH_KEY]: "unfinished",
			},
		});
		expect(ret.isError).toBeUndefined();
		expect(ret.details.returned).toBe(true);
		expect(ret.details.abandoned).toBe(true);
		expect(forkOf(ledger, "f-sub").ownerId).toBe("root");

		// Root joins /api and sees abandoned metadata
		const joined = handleJoinCall(root, { id: "j1" });
		expect(joined.isError).toBeUndefined();
		expect(joined.details.result.abandoned).toBe(true);
		expect(joined.details.result.abandonedBy).toBe("/");
		expect(joined.details.result.abandonReason).toBe("pivot to v2");
	});

	test("spawnChildTicket forced-closes abandoned scope when nudges exhaust to prevent scope_join deadlock", async () => {
		const wiring = createForkWiring();
		const { station: root } = makeStation({ wiring });
		const ledger = root.forkLedgerPort();
		registerFork(ledger, {
			forkId: "f-stuck",
			scopeId: "inspector.stuck",
			path: "/inspector.stuck",
			upscopePath: "/",
			ownerId: "root",
			callerPath: "/",
			fsm: "stuck",
			depth: 0,
		});

		let prompts = 0;
		const res = await spawnChildTicket(
			{ forkId: "f-stuck", path: "/inspector.stuck", receipt: "You are now in the scope /inspector.stuck," },
			{
				registry: wiring.registry,
				ledger,
				createSession: async () => ({
					ok: true,
					session: {
						agent: { state: { messages: [], stopReason: "stop" }, abort: () => {} },
						prompt: async () => {
							prompts += 1;
							if (prompts === 1) {
								// Simulate abandon arriving during first turn
								ledger.forks["f-stuck"].abandonRequested = true;
								ledger.forks["f-stuck"].abandonedBy = "/";
								ledger.forks["f-stuck"].abandonReason = "stop now";
							}
							// Model keeps refusing to call scope_return
						},
					},
				}),
			},
		);

		expect(res.ok).toBe(true);
		expect(res.failed).toBe(true);
		expect(forkOf(ledger, "f-stuck").status).toBe("ready");
		expect(forkOf(ledger, "f-stuck").abandonRequested).toBe(true);
	});
});
