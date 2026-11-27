// Production-shaped multi-engine regression tests for shared ForkRegistry
// routing across independent extension instances (StationRegistry per engine).
//
// In OMP, the root and every forked child run activate() and build their own
// createEngine() / StationRegistry, sharing one forkWiring singleton. Any read
// or write that hits StationRegistry instead of ForkRegistry splits the root
// and children across separate worlds.

import { describe, expect, test } from "bun:test";

import { createEngine } from "../src/engine.mjs";
import { createForkWiring } from "../src/wiring/fork-wiring.mjs";
import { setIdentity, setOutcome, outcomeOf, identityOf } from "../src/scope/fork-registry.mjs";
import { forkOf } from "../src/scope/ledger-charge.mjs";
import { markReady } from "../src/scope/ledger-brackets.mjs";
import { RETURN_OATH_KEY, RETURN_OATH_VALUE } from "../src/station/domain/handoff.mjs";
import { spawnChildTicket } from "../src/tools/spawn-ticket.mjs";

function memoryManager(id = "shared-session") {
	return {
		getSessionId: () => id,
		getBranch: () => [],
		getLeafId: () => null,
		appendCustomEntry: () => {},
		buildSessionContext: () => ({ messages: [] }),
	};
}

function makeEngineHost(sharedWiring, extraSession = {}) {
	return {
		session: {
			managerOf: (ctx) => ctx?.sessionManager ?? null,
			conversationKey: (manager) =>
				typeof manager?.getSessionId === "function"
					? `session:${manager.getSessionId()}`
					: (manager ?? null),
			branch: () => [],
			agent: (ctx) => ctx?.agent ?? null,
			abort: extraSession.abort ?? (() => {}),
		},
		fork: {
			wiring: () => sharedWiring,
			attachStation: (station, ctx) => {
				sharedWiring.attach(station, {
					conversationKey: "session:shared-session",
					identity: ctx?.identity ?? null,
				});
				sharedWiring.bind(station, {
					display: null,
					identity: ctx?.identity ?? null,
					...(ctx?.bindOptions ?? {}),
				});
			},
		},
		tools: {
			listSpecs: () => [{ name: "read" }],
			execute: async (name) => ({
				content: [{ type: "text", text: `ok:${name}` }],
			}),
		},
	};
}

function makeEnginePair(sharedWiring, extraSession = {}) {
	return createEngine({
		host: makeEngineHost(sharedWiring, extraSession),
		tickets: { steer() {}, prompt() {}, rewindRoot() {} },
		env: {},
	});
}

describe("multi-engine shared ForkRegistry isolation and poka-yoke", () => {
	test("before forkWaitPort binds, forkRegistry resolves via forkWiring (and falls back cleanly when absent)", () => {
		const wiring = createForkWiring();
		const engine = makeEnginePair(wiring);
		// Build a fresh station without attachStation calling bindForkPorts.
		const bareEngine = createEngine({
			host: {
				session: {
					managerOf: (ctx) => ctx?.sessionManager ?? null,
					conversationKey: () => "session:bare",
				},
				fork: { wiring: () => wiring },
			},
			tickets: { steer() {}, prompt() {}, rewindRoot() {} },
			env: {},
		});
		const bareStation = bareEngine.station({ sessionManager: memoryManager("bare") });
		expect(bareStation.forkWaitPort).toBeNull();
		expect(bareStation.forkRegistry()).toBe(wiring.registry);

		// A standalone station without forkWiring returns null cleanly.
		const unattachedEngine = createEngine({
			host: { session: { managerOf: (ctx) => ctx?.sessionManager ?? null } },
			tickets: { steer() {}, prompt() {}, rewindRoot() {} },
			env: {},
		});
		// Bypass the shared wiring stored on host by passing no host.fork.wiring.
		const unattached = unattachedEngine.station({ sessionManager: memoryManager("unattached") });
		expect(unattached.forkRegistry()).toBe(unattachedEngine.forkWiring().registry);

		// A prototype station without forkWaitPort or forkWiring returns null.
		const orphan = Object.create(Object.getPrototypeOf(bareStation));
		expect(orphan.forkRegistry()).toBeNull();
		expect(engine.registry).not.toBe(wiring.registry);
	});

	test("StationRegistry is frozen, station.registry is absent, and child identity/outcomes stay in shared ForkRegistry", () => {
		const wiring = createForkWiring();
		const engine = makeEnginePair(wiring);
		const ctx = { sessionManager: memoryManager() };
		const station = engine.station(ctx);

		expect(Object.isFrozen(engine.registry)).toBe(true);
		expect(station.registry).toBeUndefined();
		expect(station.forkRegistry()).toBe(wiring.registry);

		expect(() => {
			engine.registry.extra = 1;
		}).toThrow(TypeError);
	});

	test("parent -> child fork, return, and join across independent createEngine instances", async () => {
		const wiring = createForkWiring();
		const rootEngine = makeEnginePair(wiring);
		const childEngine = makeEnginePair(wiring);
		const rootManager = memoryManager("parent-child-race");
		const rootCtx = {
			sessionManager: rootManager,
			agent: { kind: "main", id: "root-agent" },
		};
		const rootStation = rootEngine.station(rootCtx);
		const [rootJs] = rootEngine.tools;
		const ledger = rootStation.forkLedgerPort();

		let spawnedSpec = null;
		let childStation = null;
		let childCtx = null;

		rootStation.childSpawnPort = () => (spec) => {
			spawnedSpec = spec;
			const identity = {
				forkId: spec.forkId,
				parentOwnerId: "root",
				ownScopeId: spec.scopeId,
				path: spec.path,
				ledger,
			};
			setIdentity(wiring.registry, spec.forkId, identity);
			spawnChildTicket(spec, {
				registry: wiring.registry,
				ledger,
				createSession: async () => {
					const childManager = memoryManager("child-branch");
					childCtx = {
						sessionManager: childManager,
						agent: { kind: "sub", id: "child-agent" },
						identity,
					};
					childStation = childEngine.station(childCtx);
					const session = {
						agent: {
							id: "child-agent",
							state: { messages: [], stopReason: "stop" },
							abort() {},
						},
						async prompt() {
							expect(childStation.projectionFor(childCtx).mode).toBe("SUBSCOPE");
							const retRes = childStation.executeReturn(
								"child-ret-1",
								{
									dafny: "child completed its work",
									[RETURN_OATH_KEY]: RETURN_OATH_VALUE,
								},
								childCtx,
							);
							expect(retRes.isError).toBeUndefined();
							setOutcome(wiring.registry, spec.forkId, {
								record: "child completed its work",
								failed: false,
								reason: null,
							});
							markReady(ledger, spec.forkId, { ok: true, record: "child completed its work" });
						},
					};
					return { ok: true, session };
				},
			}).then(() => {});
			return true;
		};

		const forked = await rootJs.execute(
			"root-fork-1",
			{
				code: `return await api.scope_fork({ forks: [{ path: "/inspector.worker", fsm: "inspect parser", profession: "You are a worker like Ada Lovelace.", n: 1, budget: { read: 2 }, targets: ["src/a.mjs"] }] });`,
			},
			null,
			null,
			rootCtx,
		);
		expect(forked.isError).toBeUndefined();
		expect(spawnedSpec.path).toBe("/inspector.worker");
		expect(identityOf(wiring.registry, spawnedSpec.forkId)?.path).toBe("/inspector.worker");

		const joinResult = await rootJs.execute(
			"root-join-1",
			{ code: "return await api.scope_join({});" },
			null,
			null,
			rootCtx,
		);
		expect(joinResult.isError).toBeUndefined();
		expect(joinResult.details.joined).toBe(true);
		expect(forkOf(ledger, spawnedSpec.forkId).status).toBe("joined");
		expect(outcomeOf(wiring.registry, spawnedSpec.forkId).record).toBe("child completed its work");
	});

	test("cancelTree fails running children across engines", () => {
		const wiring = createForkWiring();
		const engine = makeEnginePair(wiring);
		const ctx = { sessionManager: memoryManager("cancel-tree-session") };
		const station = engine.station(ctx);
		const ledger = station.forkLedgerPort();
		station.childSpawnPort = () => () => true;
		station.executeFork(
			"f-tree",
			{
				forks: [
					{
						path: "/inspector.worker",
						fsm: "cancel tree",
						profession: "You are worker.",
						n: 1,
						budget: { read: 1 },
						targets: ["t.mjs"],
					},
				],
			},
			ctx,
		);

		station.onUserAbort(ctx, { reason: "Esc pressed" });

		expect(forkOf(ledger, "f-tree").status).toBe("failed");
	});
});

