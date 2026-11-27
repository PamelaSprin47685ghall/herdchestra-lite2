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
import { setIdentity, setOutcome } from "../src/scope/fork-registry.mjs";
import {
	currentRequest,
	enqueueRequest,
	markRequestDelivered,
	pendingRequestCount,
	registerRuntime,
	resolveRequest,
	runtimeOf,
	waitEdgesOf,
} from "../src/scope/request-queue.mjs";
import { abandonDescendants, forkOf, markReady } from "../src/scope/forkjoin.mjs";
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

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function tick(ms = 0) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

	test("StationRegistry is frozen, station.registry is absent, and request-queue writes throw TypeError on it", () => {
		const wiring = createForkWiring();
		const engine = makeEnginePair(wiring);
		const ctx = { sessionManager: memoryManager() };
		const station = engine.station(ctx);

		expect(Object.isFrozen(engine.registry)).toBe(true);
		expect(station.registry).toBeUndefined();
		expect(station.forkRegistry()).toBe(wiring.registry);

		expect(() =>
			enqueueRequest(engine.registry, { from: "/", target: "/worker", message: "hi" }),
		).toThrow(TypeError);
		expect(() =>
			registerRuntime(engine.registry, "/", { state: "idle", wake: () => {} }),
		).toThrow(TypeError);
	});

	test("parent -> child request across seal race: AWAITING_REPLY, cycle refusal, post-seal drain, zero residue", async () => {
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

		let finishChildTurn = null;
		const prompts = [];
		const replies = [];
		let childStation = null;
		let childCtx = null;
		let childJs = null;

		const spawnPromise = (() => {
			// Register fork via handleForkCall-compatible flow using childSpawnPort.
			let spawnedSpec = null;
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
					registerIdle: (forkId, entry) => {
						registerRuntime(wiring.registry, spec.path, {
							state: "idle",
							wake: () => entry.drain(),
						});
					},
					createSession: async () => {
						const childManager = memoryManager("child-branch");
						childCtx = {
							sessionManager: childManager,
							agent: { kind: "sub", id: "child-agent" },
							identity,
						};
						childStation = childEngine.station(childCtx);
						[childJs] = childEngine.tools;
						const session = {
							agent: {
								id: "child-agent",
								state: { messages: [], stopReason: "stop" },
								abort() {},
							},
							async prompt(text) {
								prompts.push(text);
								if (prompts.length === 1) {
									// Child starts its work turn and waits before sealing.
									const gate = deferred();
									finishChildTurn = gate;
									await gate.promise;
									return;
								}
								// Post-seal drain prompt: child inspects receipt & answers via js scope_reply.
								const receipt = childStation.skillReceipt(childCtx);
								replies.push(receipt.content[0].text);
								expect(childStation.projectionFor(childCtx).mode).toBe("AWAITING_REPLY");
								await childJs.execute(
									"child-reply-1",
									{ code: "return await api.scope_reply('answer from child');" },
									null,
									null,
									childCtx,
								);
							},
						};
						return { ok: true, session };
					},
				}).then(() => {});
				return true;
			};
			return rootJs.execute(
				"root-fork-1",
				{
					code: `return await api.scope_fork({ forks: [{ scopeId: "worker", fsm: "inspect parser", profession: "You are a worker like Ada Lovelace.", n: 1, budget: { read: 2 }, targets: ["src/a.mjs"] }] });`,
				},
				null,
				null,
				rootCtx,
			).then(() => spawnedSpec);
		})();

		const spec = await spawnPromise;
		expect(spec.path).toBe("/worker");
		while (!finishChildTurn) await tick(2);

		// Parent requests child while child is running (in another engine/StationRegistry).
		const parentReqPromise = rootJs.execute(
			"root-req-1",
			{
				code: `return await api.scope_request({ target: "/worker", message: "which line?" });`,
			},
			null,
			null,
			rootCtx,
		);
		await tick(2);

		// Child observes AWAITING_REPLY in its own engine; reverse question triggers REQUEST_DEADLOCK_CYCLE.
		const childSnap = childStation.projectionFor(childCtx);
		expect(childSnap.mode).toBe("AWAITING_REPLY");
		expect(childSnap.state.request).toEqual({ from: "/", message: "which line?" });

		// Child still parked in its turn tries to ask "/" back -> cycle guard refuses immediately.
		const reverseAttempt = childStation.handleScopeRequest({
			toolCallId: "child-cycle",
			params: { target: "/", message: "counter-question" },
			ctx: childCtx,
		});
		expect(reverseAttempt.isError).toBe(true);
		expect(reverseAttempt.details.code).toBe("REQUEST_DEADLOCK_CYCLE");

		// Child seals with scope_return before answering, then its spawn turn finishes -> post-seal drain runs.
		const retRes = childStation.executeReturn(
			"child-ret-1",
			{
				dafny: "child completed its work before answering",
				[RETURN_OATH_KEY]: RETURN_OATH_VALUE,
			},
			childCtx,
		);
		expect(retRes.isError).toBeUndefined();
		expect(forkOf(ledger, spec.forkId).status).toBe("ready");

		finishChildTurn.resolve();

		const reqResult = await parentReqPromise;
		expect(reqResult.isError).toBeUndefined();
		expect(reqResult.details.result).toEqual({
			ok: true,
			from: "/worker",
			reply: "answer from child",
		});

		const joinResult = await rootJs.execute(
			"root-join-1",
			{ code: "return await api.scope_join({});" },
			null,
			null,
			rootCtx,
		);
		expect(joinResult.isError).toBeUndefined();
		expect(joinResult.details.joined).toBe(true);
		expect(forkOf(ledger, spec.forkId).status).toBe("joined");
		expect(pendingRequestCount(wiring.registry, "/worker")).toBe(0);
		expect(waitEdgesOf(wiring.registry, "/")).toEqual([]);
		expect(waitEdgesOf(wiring.registry, "/worker")).toEqual([]);
	});

	test("sibling -> sibling scope_request across 3 independent createEngine instances", async () => {
		const wiring = createForkWiring();
		const rootEngine = makeEnginePair(wiring);
		const alphaEngine = makeEnginePair(wiring);
		const betaEngine = makeEnginePair(wiring);

		const rootStation = rootEngine.station({
			sessionManager: memoryManager("sibling-session"),
			agent: { kind: "main", id: "root" },
		});
		const ledger = rootStation.forkLedgerPort();
		rootStation.childSpawnPort = () => () => true;

		const forked = rootStation.executeFork(
			"fork-siblings",
			{
				forks: [
					{
						scopeId: "alpha",
						fsm: "alpha work",
						profession: "You are alpha.",
						n: 1,
						budget: { read: 1 },
						targets: ["a.mjs"],
					},
					{
						scopeId: "beta",
						fsm: "beta work",
						profession: "You are beta.",
						n: 1,
						budget: { read: 1 },
						targets: ["b.mjs"],
					},
				],
			},
			{},
		);
		expect(forked.isError).toBeUndefined();
		const [alphaForkId, betaForkId] = forked.details.started;

		const alphaCtx = {
			sessionManager: memoryManager("alpha-branch"),
			agent: { kind: "sub", id: "alpha-agent" },
			identity: { forkId: alphaForkId, parentOwnerId: "root", ownScopeId: "alpha", path: "/alpha", ledger },
		};
		const betaCtx = {
			sessionManager: memoryManager("beta-branch"),
			agent: { kind: "sub", id: "beta-agent" },
			identity: { forkId: betaForkId, parentOwnerId: "root", ownScopeId: "beta", path: "/beta", ledger },
		};
		alphaEngine.station(alphaCtx);
		const betaStation = betaEngine.station(betaCtx);

		// /beta runs in betaEngine, /alpha asks /beta from alphaEngine.
		registerRuntime(wiring.registry, "/beta", { state: "running" });
		const [alphaJs] = alphaEngine.tools;
		const [betaJs] = betaEngine.tools;

		const pending = alphaJs.execute(
			"alpha-req",
			{ code: `return await api.scope_request({ target: "/beta", message: "exports?" });` },
			null,
			null,
			alphaCtx,
		);
		await tick(2);

		expect(currentRequest(wiring.registry, "/beta")?.from).toBe("/alpha");
		const betaReceipt = betaStation.skillReceipt(betaCtx);
		expect(betaReceipt.content[0].text).toContain("AWAITING_REPLY");
		expect(betaStation.projectionFor(betaCtx).mode).toBe("AWAITING_REPLY");

		const betaReplied = await betaJs.execute(
			"beta-rep",
			{ code: `return await api.scope_reply("foo, bar");` },
			null,
			null,
			betaCtx,
		);
		expect(betaReplied.isError).toBeUndefined();

		const answer = await pending;
		expect(answer.isError).toBeUndefined();
		expect(answer.details.result).toEqual({ ok: true, from: "/beta", reply: "foo, bar" });
		expect(pendingRequestCount(wiring.registry, "/beta")).toBe(0);
		expect(waitEdgesOf(wiring.registry, "/alpha")).toEqual([]);
	});

	test("cancelTree clears child runtime hooks and rejects pending requests", async () => {
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
						scopeId: "worker",
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
		registerRuntime(wiring.registry, "/worker", { state: "running", interrupt: () => {} });
		const pending = enqueueRequest(wiring.registry, {
			from: "/",
			target: "/worker",
			message: "before esc",
		});

		station.onUserAbort(ctx, { reason: "Esc pressed" });

		await expect(pending.promise).rejects.toThrow();
		expect(pendingRequestCount(wiring.registry, "/worker")).toBe(0);
		expect(runtimeOf(wiring.registry, "/worker")).toBeNull();
		expect(waitEdgesOf(wiring.registry, "/")).toEqual([]);
		expect(forkOf(ledger, "f-tree").status).toBe("failed");
	});

	test("child -> root '/' requests: idle wake, running interrupt, and parked yieldJoin", async () => {
		const wiring = createForkWiring();
		const rootAbortControllers = new Map();
		const rootEngine = makeEnginePair(wiring, {
			abort: (ctx, reason) => rootAbortControllers.get(ctx)?.abort(reason),
		});
		const childEngine = makeEnginePair(wiring);

		const rootCtx = {
			sessionManager: memoryManager("child-to-root"),
			agent: { kind: "main", id: "root" },
		};
		const rootStation = rootEngine.station(rootCtx);
		const ledger = rootStation.forkLedgerPort();
		rootStation.childSpawnPort = () => () => true;
		const forked = rootStation.executeFork(
			"fork-c",
			{
				forks: [
					{
						scopeId: "worker",
						fsm: "ask root",
						profession: "You are worker.",
						n: 1,
						budget: { read: 1 },
						targets: ["x.mjs"],
					},
				],
			},
			rootCtx,
		);
		const childForkId = forked.details.started[0];
		const childCtx = {
			sessionManager: memoryManager("child-branch"),
			agent: { kind: "sub", id: "child" },
			identity: { forkId: childForkId, parentOwnerId: "root", ownScopeId: "worker", path: "/worker", ledger },
		};
		childEngine.station(childCtx);
		const [rootJs] = rootEngine.tools;
		const [childJs] = childEngine.tools;

		// 1) Root is idle via noteRootRuntime.
		let idleWakes = 0;
		expect(
			rootStation.noteRootRuntime(() => {
				idleWakes += 1;
			}),
		).toBe(true);
		const idleReq = childJs.execute(
			"c-req-idle",
			{ code: `return await api.scope_request({ target: "/", message: "idle ping" });` },
			null,
			null,
			childCtx,
		);
		await tick(2);
		expect(idleWakes).toBe(1);
		rootStation.skillReceipt(rootCtx);
		await rootJs.execute("r-rep-idle", { code: `return await api.scope_reply("idle pong");` }, null, null, rootCtx);
		expect((await idleReq).details.result).toEqual({ ok: true, from: "/", reply: "idle pong" });

		// 2) Root is running a js beat via beginRootBeat and interrupted with interrupt: true.
		const beatController = new AbortController();
		rootAbortControllers.set(rootCtx, beatController);
		const runningBeat = rootJs.execute(
			"r-beat",
			{ code: "await new Promise(() => {});" },
			beatController.signal,
			null,
			rootCtx,
		);
		await tick(2);
		expect(runtimeOf(wiring.registry, "/")?.state).toBe("running");

		const intReq = childJs.execute(
			"c-req-int",
			{ code: `return await api.scope_request({ target: "/", message: "stop beat", interrupt: true });` },
			null,
			null,
			childCtx,
		);
		const beatOut = await runningBeat;
		expect(beatOut.isError).toBe(true);
		expect(beatOut.details.code).toBe("JS_INTERRUPTED");
		expect(idleWakes).toBe(2);
		rootStation.skillReceipt(rootCtx);
		await rootJs.execute("r-rep-int", { code: `return await api.scope_reply("int pong");` }, null, null, rootCtx);
		const intOut = await intReq;
		expect(intOut.isError).toBeUndefined();
		expect(intOut.details.result).toEqual({ ok: true, from: "/", reply: "int pong" });

		// 3) Root is parked in scope_join; child's scope_request yields the join
		// (without requiring root interrupt, because yieldJoin frees the parked wait).
		const joinPromise = rootJs.execute(
			"r-join",
			{ code: `return await api.scope_join({});` },
			null,
			null,
			rootCtx,
		);
		await tick(5);
		expect(runtimeOf(wiring.registry, "/")?.parked?.size).toBe(1);
		expect(typeof runtimeOf(wiring.registry, "/")?.yieldJoins?.get("r-join#0")).toBe("function");

		const yieldReq = childJs.execute(
			"c-req-yield",
			{ code: `return await api.scope_request({ target: "/", message: "yield join" });` },
			null,
			null,
			childCtx,
		);
		await tick(5);
		const joinOut = await joinPromise;
		expect(joinOut.isError).toBe(true);
		expect(joinOut.content[0].text).toMatch(/interrupted/i);
		expect(runtimeOf(wiring.registry, "/")?.state).toBe("idle");
		expect(idleWakes).toBe(3);
		rootStation.skillReceipt(rootCtx);
		const repYield = await rootJs.execute("r-rep-yield", { code: `return await api.scope_reply("yield pong");` }, null, null, rootCtx);
		expect(repYield.isError).toBeUndefined();
		expect((await yieldReq).details.result).toEqual({ ok: true, from: "/", reply: "yield pong" });
		// Clean up child bracket.
		markReady(ledger, childForkId, { ok: true, record: "done" });
	});

	test("cancelled child does not drain or register idle after seal/abort", async () => {
		const wiring = createForkWiring();
		const engine = makeEnginePair(wiring);
		const station = engine.station({ sessionManager: memoryManager("cancel-test") });
		const ledger = station.forkLedgerPort();
		station.childSpawnPort = () => () => true;
		station.executeFork(
			"f-cancel",
			{
				forks: [
					{
						scopeId: "worker",
						fsm: "cancel test",
						profession: "You are worker.",
						n: 1,
						budget: { read: 1 },
						targets: ["c.mjs"],
					},
				],
			},
			{},
		);
		const childFork = ledger.forks["f-cancel"];
		const pendingReq = enqueueRequest(wiring.registry, {
			from: "/",
			target: "/worker",
			message: "stale question",
		});

		let prompts = 0;
		let idleRegistered = false;
		const spawnOut = await spawnChildTicket(
			{ forkId: childFork.forkId, receipt: "You are now in the scope /worker" },
			{
				registry: wiring.registry,
				ledger,
				registerIdle: () => {
					idleRegistered = true;
				},
				createSession: async () => ({
					ok: true,
					session: {
						agent: { id: "a-cancel", state: { messages: [], stopReason: "stop" }, abort() {} },
						async prompt() {
							prompts += 1;
							// Parent cancels child mid-turn (e.g., via scope_abandon / cancelTree).
							abandonDescendants(ledger, "root", "cancelled by parent");
						},
					},
				}),
			},
		);

		expect(spawnOut.ok).toBe(true);
		// Must not re-prompt post-cancel or register an idle wake handle.
		expect(prompts).toBe(1);
		expect(idleRegistered).toBe(false);
		expect(runtimeOf(wiring.registry, "/worker")).toBeNull();
		await expect(pendingReq.promise).rejects.toThrow();
		expect(pendingRequestCount(wiring.registry, "/worker")).toBe(0);
	});

	test("post-seal drain empties 2 backlogged requests and bounds unanswered requests via MAX_WAKE_ATTEMPTS", async () => {
		const wiring = createForkWiring();
		const ledger = wiring.registry.ledgerKeyed.get("drain-test") ?? null;
		const engine = makeEnginePair(wiring);
		const station = engine.station({ sessionManager: memoryManager("drain-test") });
		const sharedLedger = station.forkLedgerPort();
		expect(ledger).toBeNull();
		station.childSpawnPort = () => () => true;

		// Case A: 2 requests queued before seal are BOTH drained after seal.
		station.executeFork(
			"f-drain",
			{
				forks: [
					{
						scopeId: "worker",
						fsm: "drain two",
						profession: "You are worker.",
						n: 1,
						budget: { read: 1 },
						targets: ["d.mjs"],
					},
				],
			},
			{},
		);
		const workerFork = sharedLedger.forks["f-drain"];
		const req1 = enqueueRequest(wiring.registry, { from: "/", target: "/worker", message: "q1" });
		const req2 = enqueueRequest(wiring.registry, { from: "/", target: "/worker", message: "q2" });

		let prompts = 0;
		const session = {
			agent: { id: "a-drain", state: { messages: [], stopReason: "stop" }, abort() {} },
			async prompt() {
				prompts += 1;
				if (prompts === 1) {
					// Seal on first turn without answering either request yet.
					setOutcome(wiring.registry, workerFork.forkId, {
						record: "sealed",
						failed: false,
						reason: null,
					});
					markReady(sharedLedger, workerFork.forkId, { ok: true, record: "sealed" });
					return;
				}
				const head = currentRequest(wiring.registry, "/worker");
				if (head) {
					markRequestDelivered(wiring.registry, "/worker");
					resolveRequest(wiring.registry, "/worker", `reply:${head.message}`);
				}
			},
		};

		let idleRegistered = false;
		const spawnOut = await spawnChildTicket(
			{ forkId: workerFork.forkId, receipt: "You are now in the scope /worker" },
			{
				registry: wiring.registry,
				ledger: sharedLedger,
				registerIdle: () => {
					idleRegistered = true;
				},
				createSession: async () => ({ ok: true, session }),
			},
		);
		expect(spawnOut.failed).toBe(false);
		expect(idleRegistered).toBe(true);
		await expect(req1.promise).resolves.toBe("reply:q1");
		await expect(req2.promise).resolves.toBe("reply:q2");
		expect(pendingRequestCount(wiring.registry, "/worker")).toBe(0);

		// Case B: Child seals but ignores pending request -> MAX_WAKE_ATTEMPTS (2) rejects caller instead of hanging.
		station.executeFork(
			"f-refuse",
			{
				forks: [
					{
						scopeId: "stubborn",
						fsm: "refuse reply",
						profession: "You are worker.",
						n: 1,
						budget: { read: 1 },
						targets: ["s.mjs"],
					},
				],
			},
			{},
		);
		const stubbornFork = sharedLedger.forks["f-refuse"];
		const stuckReq = enqueueRequest(wiring.registry, {
			from: "/",
			target: "/stubborn",
			message: "ignored",
		});
		const stubbornPrompts = [];
		const stubbornSession = {
			agent: { id: "a-stubborn", state: { messages: [], stopReason: "stop" }, abort() {} },
			async prompt(text) {
				stubbornPrompts.push(text);
				if (stubbornPrompts.length === 1) {
					setOutcome(wiring.registry, stubbornFork.forkId, {
						record: "sealed",
						failed: false,
						reason: null,
					});
					markReady(sharedLedger, stubbornFork.forkId, { ok: true, record: "sealed" });
				}
				// Never answers the queued request.
			},
		};
		await spawnChildTicket(
			{ forkId: stubbornFork.forkId, receipt: "You are now in the scope /stubborn" },
			{
				registry: wiring.registry,
				ledger: sharedLedger,
				createSession: async () => ({ ok: true, session: stubbornSession }),
			},
		);
		await expect(stuckReq.promise).rejects.toThrow("the scope did not answer");
		expect(pendingRequestCount(wiring.registry, "/stubborn")).toBe(0);
	});
});
