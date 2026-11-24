// The fork/join domain is pure: plain snapshots in, plain decisions out.
// These cases pin the consumer-visible edges the handlers rely on.

import { describe, expect, test } from "bun:test";

import {
	decideAbandon,
	decideForkAdmission,
	decideJoinAdmission,
	decideReady,
	decideRegister,
	decideReturn,
	validateFork,
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
			receiptChars: 2_000,
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
			receiptChars: 2,
			tokensPerChar: 0.3,
			window: WINDOW,
		});
		expect(() => decideForkAdmission(input)).not.toThrow();
	});
});

describe("fork validation and register", () => {
	const item = {
		scopeId: "probe",
		fsm: "x",
		budget: { read: 1 },
		time: 30,
		targets: ["src/parser.mjs"],
	};

	test("validateFork normalizes targets and leaves the fsm to the decision", () => {
		expect(validateFork(item).ok).toBe(true);
		expect(validateFork({ ...item, fsm: "  " })).toMatchObject({ ok: true, fsm: "" });
		expect(validateFork({ ...item, budget: { read: -1 } }).code).toBe("INVALID_BUDGET");
		expect(validateFork({ ...item, targets: [] }).code).toBe("INVALID_TARGETS");
		expect(
			validateFork({ ...item, targets: [" src/parser.mjs ", "src/cache.mjs"] }).targets,
		).toEqual(["src/parser.mjs", "src/cache.mjs"]);
	});

	test("decideRegister amends a live scope id instead of refusing", () => {
		const out = decideRegister({
			items: [validateFork(item)],
			forks: [
				{
					forkId: "f1",
					scopeId: "probe",
					ownerId: "root",
					status: "running",
					generation: 1,
				},
			],
			hasSpawner: true,
		});
		expect(out.ok).toBe(true);
		expect(out.items[0].action).toBe("amend");
		expect(out.items[0].targetForkId).toBe("f1");
	});

	test("decideRegister refuses a scope id owned by another branch", () => {
		const out = decideRegister({
			items: [validateFork(item)],
			forks: [
				{
					forkId: "f1",
					scopeId: "probe",
					ownerId: "someone-else",
					status: "running",
					generation: 1,
				},
			],
			ownerId: "root",
			hasSpawner: true,
		});
		expect(out.ok).toBe(false);
		expect(out.code).toBe("FOREIGN_SCOPE_ID");
	});

	test("decideRegister requires a spawner only for a runnable batch", () => {
		const blocked = validateFork({ ...item, blocked: true });
		expect(
			decideRegister({ items: [blocked], forks: [], hasSpawner: false }).ok,
		).toBe(true);
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
			pricedChars: [{ fresh: 10_000, revive: 10_000, generation: 10_000 }],
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
