// The fork/join domain is pure: plain snapshots in, plain decisions out.
// These cases pin the consumer-visible edges the handlers rely on.

import { describe, expect, test } from "bun:test";
import vm from "node:vm";

import {
	decideAbandon,
	decideForkAdmission,
	decideJoinAdmission,
	decideReady,
	decideRegister,
	decideReturn,
	validateFork,
	validateForkBatch,
} from "../../../src/station/domain/fork-join.mjs";

const WINDOW = 100_000;

describe("admission decisions", () => {
	test("a measured request under the window is admitted", () => {
		const out = decideJoinAdmission({
			baseTokens: 1_000,
			recordChars: 1_000,
			tokensPerChar: 0.3,
			window: WINDOW,
			reserve: 100,
			margin: 100,
		});
		expect(out.ok).toBe(true);
		expect(out.source).toBe("measured");
	});

	test("a request over the window is refused with its numbers", () => {
		const out = decideJoinAdmission({
			baseTokens: WINDOW,
			recordChars: 10_000,
			tokensPerChar: 0.3,
			window: WINDOW,
			reserve: 100,
			margin: 100,
		});
		expect(out.ok).toBe(false);
		expect(out.code).toBe("JOIN_CONTEXT_EXCEEDED");
		expect(out.overBy).toBeGreaterThan(0);
	});

	test("an unknown window is unproven, not a refusal", () => {
		const out = decideJoinAdmission({
			baseTokens: 1,
			recordChars: 1,
			window: null,
		});
		expect(out.ok).toBe(true);
		expect(out.source).toBe("unknown-window");
	});

	test("fork admission prices the receipt characters", () => {
		const out = decideForkAdmission({
			baseTokens: 1_000,
			pricedChars: { fresh: 2_000, revive: 2_000, generation: 2_000 },
			path: "fresh",
			tokensPerChar: 0.3,
			window: WINDOW,
			reserve: 100,
			margin: 100,
		});
		expect(out.ok).toBe(true);
		expect(out.projected).toBe(1_600);
	});

	test("admission does not mutate a frozen input", () => {
		const input = Object.freeze({
			baseTokens: 1,
			pricedChars: { fresh: 2, revive: 2, generation: 2 },
			path: "fresh",
			tokensPerChar: 0.3,
			window: WINDOW,
		});
		expect(() => decideForkAdmission(input)).not.toThrow();
	});
});

describe("fork validation and register", () => {
	const item = {
		path: "inspector.probe",
		fsm: "x",
		profession: "You are a probe engineer like Barbara Liskov.",
		budget: { read: 1 },
		time: 30,
		targets: ["src/parser.mjs"],
	};

	test("validateFork refuses a blank fsm and normalizes targets", () => {
		expect(validateFork(item).ok).toBe(true);
		expect(validateFork({ ...item, fsm: "  " })).toMatchObject({
			ok: false,
			code: "INVALID_FSM",
		});
		expect(validateFork({ ...item, budget: { read: -1 } }).code).toBe("INVALID_BUDGET");
		expect(validateFork({ ...item, targets: [] }).code).toBe("INVALID_TARGETS");
		expect(
			validateFork({ ...item, targets: [" src/parser.mjs ", "src/cache.mjs"] }).targets,
		).toEqual(["src/parser.mjs", "src/cache.mjs"]);
	});

	test("JSON-encoded complex fields are coerced before validation", () => {
		expect(validateForkBatch({ forks: JSON.stringify([item]) }).ok).toBe(true);
		expect(validateForkBatch([item]).ok).toBe(true);
		expect(validateForkBatch({ forks: [JSON.stringify(item)] }).ok).toBe(true);
		expect(validateFork({ ...item, budget: '{"read":1}' }).budget).toEqual({ read: 1 });
		expect(validateFork({ ...item, targets: '["src/parser.mjs"]' }).targets).toEqual([
			"src/parser.mjs",
		]);
	});

	test("coercion leaves genuine type errors intact", () => {
		expect(validateForkBatch({ forks: 42 }).code).toBe("INVALID_FORKS");
		expect(validateForkBatch({ forks: '{"path":"x"}' }).code).toBe("INVALID_FORKS");
		expect(validateFork({ ...item, budget: [1] }).code).toBe("INVALID_BUDGET");
		expect(validateFork({ ...item, budget: "not json" }).code).toBe("INVALID_BUDGET");
		expect(validateFork({ ...item, targets: '{"a":1}' }).code).toBe("INVALID_TARGETS");
	});

	test("a fork issued from the js sandbox validates", () => {
		const sandbox = vm.createContext(Object.create(null));
		const foreign = vm.runInContext(
			`({
				path: "inspector.probe",
				fsm: "x",
				profession: "You are a probe engineer like Barbara Liskov.",
				budget: { read: 1 },
				targets: ["src/parser.mjs"],
			})`,
			sandbox,
		);
		const out = validateFork(foreign);
		expect(out.ok).toBe(true);
		expect(out.budget).toEqual({ read: 1 });
		expect(validateFork({ ...item, budget: new Map() }).code).toBe("INVALID_BUDGET");
	});

	test("decideRegister fails closed on a taken path instead of renaming", () => {
		const out = decideRegister({
			items: [validateFork(item)],
			forks: [
				{
					forkId: "f1",
					scopeId: "inspector.probe",
					ownerId: "root",
					path: "/inspector.probe",
					status: "running",
				},
			],
			hasSpawner: true,
		});
		expect(out.ok).toBe(false);
		expect(out.code).toBe("DUPLICATE_SCOPE_PATH");
	});

	test("decideRegister fails closed on a taken path regardless of owner", () => {
		const out = decideRegister({
			items: [validateFork(item)],
			forks: [
				{
					forkId: "f1",
					scopeId: "inspector.probe",
					ownerId: "someone-else",
					path: "/inspector.probe",
					status: "running",
				},
			],
			hasSpawner: true,
		});
		expect(out.ok).toBe(false);
		expect(out.code).toBe("DUPLICATE_SCOPE_PATH");
	});

	test("decideRegister requires a spawner for a runnable batch", () => {
		const runnable = validateFork(item);
		expect(
			decideRegister({ items: [runnable], forks: [], hasSpawner: false }).code,
		).toBe("CHILD_SPAWNER_UNAVAILABLE");
	});

	test("decideRegister refuses an over-window fork without mutating input", () => {
		const runnable = Object.freeze(validateFork(item));
		const out = decideRegister({
			items: [runnable],
			forks: [],
			hasSpawner: true,
			pricedChars: [{ fresh: 10_000 }],
			baseTokens: 100_000,
			tokensPerChar: 0.3,
			window: 100_000,
			reserve: 100,
			margin: 100,
		});
		expect(out.ok).toBe(false);
		expect(out.code).toBe("FORK_CONTEXT_EXCEEDED");
		expect(out.index).toBe(0);
	});

	test("decideRegister refuses a path segment that carries no role", () => {
		const out = decideRegister({
			items: [validateFork({ ...item, path: "worker" })],
			forks: [],
			callerPath: "/",
			hasSpawner: true,
		});
		expect(out.ok).toBe(false);
		expect(out.code).toBe("INVALID_PATH");
		expect(out.index).toBe(0);
	});

	test("decideRegister refuses a wider role than the caller holds", () => {
		// A devops caller may open devops, editor, or inspector — never a manager.
		const out = decideRegister({
			items: [validateFork({ ...item, path: "/manager.boss" })],
			forks: [],
			callerPath: "/devops.api",
			hasSpawner: true,
		});
		expect(out.ok).toBe(false);
		expect(out.code).toBe("ROLE_ESCALATION");
		expect(out.callerRole).toBe("devops");
		expect(out.targetRole).toBe("manager");
	});

	test("decideRegister lets a manager fork a narrower role under a done upscope", () => {
		const out = decideRegister({
			items: [validateFork({ ...item, path: "/inspector.peter/editor.eve" })],
			forks: [
				{
					forkId: "pete",
					scopeId: "inspector.peter",
					path: "/inspector.peter",
					status: "ready",
					safeSnapshotLeafId: "leaf-peter",
				},
			],
			callerPath: "/",
			hasSpawner: true,
		});
		expect(out.ok).toBe(true);
		expect(out.items[0].role).toBe("editor");
		expect(out.items[0].path).toBe("/inspector.peter/editor.eve");
		expect(out.items[0].upscopeId).toBe("pete");
	});

	test("decideRegister keeps one devops running globally, including within one batch", () => {
		const live = {
			forkId: "dv",
			scopeId: "devops.alice",
			path: "/devops.alice",
			status: "running",
		};
		const busy = decideRegister({
			items: [validateFork({ ...item, path: "devops.bob" })],
			forks: [live],
			callerPath: "/",
			hasSpawner: true,
		});
		expect(busy.ok).toBe(false);
		expect(busy.code).toBe("DEVOPS_ALREADY_RUNNING");
		expect(busy.activePath).toBe("/devops.alice");

		const free = decideRegister({
			items: [validateFork({ ...item, path: "devops.bob" })],
			forks: [{ ...live, status: "ready" }],
			callerPath: "/",
			hasSpawner: true,
		});
		expect(free.ok).toBe(true);

		const batch = decideRegister({
			items: [
				validateFork({ ...item, path: "devops.one" }),
				validateFork({ ...item, path: "devops.two" }),
			],
			forks: [],
			callerPath: "/",
			hasSpawner: true,
		});
		expect(batch.ok).toBe(false);
		expect(batch.code).toBe("DEVOPS_ALREADY_RUNNING");
		expect(batch.index).toBe(1);
	});

	test("an editor must name concrete files, and no role may fund a tool it cannot hold", () => {
		const noFiles = decideRegister({
			items: [validateFork({ ...item, path: "editor.eve", targets: ["the caching parts"] })],
			forks: [],
			callerPath: "/",
			hasSpawner: true,
		});
		expect(noFiles.ok).toBe(false);
		expect(noFiles.code).toBe("INVALID_EDITOR_TARGETS");

		const editorBash = decideRegister({
			items: [validateFork({ ...item, path: "editor.eve", budget: { bash: 1 } })],
			forks: [],
			callerPath: "/",
			hasSpawner: true,
		});
		expect(editorBash.ok).toBe(false);
		expect(editorBash.code).toBe("FORBIDDEN_ROLE_BUDGET");
		expect(editorBash.tool).toBe("bash");

		const managerPaid = decideRegister({
			items: [validateFork({ ...item, path: "manager.tom", budget: { read: 1 } })],
			forks: [],
			callerPath: "/",
			hasSpawner: true,
		});
		expect(managerPaid.ok).toBe(false);
		expect(managerPaid.code).toBe("FORBIDDEN_ROLE_BUDGET");
		expect(managerPaid.role).toBe("manager");
	});

	test("a manager may omit budget and targets entirely", () => {
		const bare = {
			path: "manager.tom",
			fsm: "delegate the work",
			profession: "You are a manager like Grace Hopper.",
		};
		const out = decideRegister({
			items: [validateFork(bare)],
			forks: [],
			callerPath: "/",
			hasSpawner: true,
		});
		expect(out.ok).toBe(true);
		expect(out.items[0].role).toBe("manager");
		expect(out.items[0].budget).toEqual({});
		expect(out.items[0].targets).toEqual([]);
	});
});

describe("return, ready and abandon gates", () => {
	test("decideReturn names each refusal", () => {
		const record = { forkId: "f1", status: "running", ownerId: "root" };
		expect(decideReturn({ identityForkId: "" }).code).toBe("NOT_A_CHILD");
		expect(
			decideReturn({ identityForkId: "f1", record: null }).code,
		).toBe("UNKNOWN_FORK");
		expect(
			decideReturn({
				identityForkId: "f1",
				record: { ...record, status: "ready" },
				receiverId: "root",
			}).code,
		).toBe("FORK_NOT_RUNNING");
		expect(
			decideReturn({
				identityForkId: "f1",
				record,
				receiverId: "",
			}).code,
		).toBe("ORPHANS_WITHOUT_RECEIVER");
		expect(
			decideReturn({
				identityForkId: "f1",
				record,
				receiverId: "root",
				orphans: ["c1"],
			}),
		).toMatchObject({ ok: true, receiverId: "root", orphans: ["c1"] });
	});

	test("decideReady normalizes the outcome and keeps failures", () => {
		const record = { forkId: "f1", status: "running" };
		expect(decideReady({ record })).toEqual({ ok: true, outcome: { ok: true } });
		expect(
			decideReady({ record, outcome: { ok: false, reason: "boom" } }),
		).toEqual({ ok: true, outcome: { ok: false, reason: "boom" } });
		expect(
			decideReady({ record, outcome: { ok: true, record: "text" } }),
		).toEqual({ ok: true, outcome: { ok: true, record: "text" } });
		expect(
			decideReady({ record: { ...record, status: "joined" } }).code,
		).toBe("FORK_NOT_RUNNING");
	});

	test("decideAbandon refuses unknown and joined records", () => {
		expect(decideAbandon({ record: null }).code).toBe("UNKNOWN_FORK");
		expect(
			decideAbandon({ record: { forkId: "f1", status: "joined" } }).code,
		).toBe("FORK_ALREADY_JOINED");
		expect(decideAbandon({ record: { forkId: "f1", status: "running" } })).toEqual({
			ok: true,
			status: "failed",
		});
	});
});
