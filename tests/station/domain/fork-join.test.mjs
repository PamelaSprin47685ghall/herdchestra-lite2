// The fork/join domain is pure: plain snapshots in, plain decisions out.
// These cases pin the consumer-visible edges the handlers rely on.

import { describe, expect, test } from "bun:test";

import {
	decideAbandon,
	decideForkAdmission,
	decideJoinAdmission,
	decideJoinBinding,
	decidePendingReport,
	decideReady,
	decideRegister,
	decideReturn,
	validateFork,
} from "../../../src/station/domain/fork-join.mjs";

const WINDOW = 100_000;

function receipt(overrides = {}) {
	return {
		forkToolCallId: "f1",
		closeToolCallId: "j1",
		levelKey: "root|0|0",
		closedOrder: 1,
		report: null,
		collapsed: false,
		...overrides,
	};
}

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

describe("pending report", () => {
	test("no receipts and no reports is no obligation", () => {
		expect(
			decidePendingReport({
				receipts: [],
				levelKey: "root|0|0",
				reports: new Map(),
				ownerId: "root",
			}),
		).toBeNull();
	});

	test("the youngest unreported receipt at the level is the obligation", () => {
		const receipts = [
			receipt({ forkToolCallId: "f1", closeToolCallId: "j1", closedOrder: 1 }),
			receipt({ forkToolCallId: "f2", closeToolCallId: "j2", closedOrder: 2 }),
		];
		expect(
			decidePendingReport({
				receipts,
				levelKey: "root|0|0",
				reports: new Map(),
				ownerId: "root",
			}),
		).toEqual({ forkId: "f2", closeToolCallId: "j2" });
	});

	test("a reported youngest receipt is discharged", () => {
		const receipts = [receipt({ report: "done" })];
		expect(
			decidePendingReport({
				receipts,
				levelKey: "root|0|0",
				reports: new Map(),
				ownerId: "root",
			}),
		).toBeNull();
	});

	test("a reported receipt at another level does not hide an unreported one", () => {
		const receipts = [
			receipt({
				forkToolCallId: "f1",
				closeToolCallId: "j1",
				levelKey: "root|0|0",
				closedOrder: 1,
			}),
			receipt({
				forkToolCallId: "f2",
				closeToolCallId: "j2",
				levelKey: "root|1|0",
				closedOrder: 2,
				report: "done",
			}),
		];
		expect(
			decidePendingReport({
				receipts,
				levelKey: "root|0|0",
				reports: new Map(),
				ownerId: "root",
			}),
		).toEqual({ forkId: "f1", closeToolCallId: "j1" });
	});

	test("the legacy reports map string is accepted", () => {
		const reports = new Map([["root", "f-legacy"]]);
		expect(
			decidePendingReport({
				receipts: [],
				levelKey: "root|0|0",
				reports,
				ownerId: "root",
			}),
		).toEqual({ forkId: "f-legacy", closeToolCallId: null });
	});

	test("the reports map object is copied, not returned", () => {
		const pending = { forkId: "f1", closeToolCallId: "j1" };
		const reports = new Map([["root", pending]]);
		const out = decidePendingReport({
			receipts: [],
			levelKey: "root|0|0",
			reports,
			ownerId: "root",
		});
		expect(out).toEqual(pending);
		expect(out).not.toBe(pending);
	});

	test("frozen inputs are not mutated", () => {
		const receipts = Object.freeze([Object.freeze(receipt())]);
		const reports = new Map([
			["root", Object.freeze({ forkId: "f-old", closeToolCallId: null })],
		]);
		expect(() =>
			decidePendingReport({
				receipts,
				levelKey: "root|0|0",
				reports,
				ownerId: "root",
			}),
		).not.toThrow();
	});
});

describe("join binding", () => {
	const expected = { forkId: "f1", closeToolCallId: "j1" };
	const same = { forkId: "f1", closeToolCallId: "j1" };
	const moved = { forkId: "f2", closeToolCallId: "j2" };

	test("both empty is current", () => {
		expect(decideJoinBinding({ expected: null, current: null })).toEqual({
			ok: true,
		});
	});

	test("the same receipt key is current", () => {
		expect(decideJoinBinding({ expected, current: same })).toEqual({ ok: true });
		expect(
			decideJoinBinding({
				expected: { forkId: "f1", closeToolCallId: null },
				current: { forkId: "f1", closeToolCallId: null },
			}),
		).toEqual({ ok: true });
	});

	test("a cleared chain names the receipt that never got its report", () => {
		expect(decideJoinBinding({ expected, current: null })).toEqual({
			ok: false,
			code: "STALE_ELDER_REPORT",
			side: "cleared",
			forkId: "f1",
		});
	});

	test("a moved chain names the receipt the model never read", () => {
		expect(decideJoinBinding({ expected, current: moved })).toEqual({
			ok: false,
			code: "STALE_ELDER_REPORT",
			side: "moved",
			forkId: "f2",
		});
		expect(decideJoinBinding({ expected: null, current: moved })).toEqual({
			ok: false,
			code: "STALE_ELDER_REPORT",
			side: "moved",
			forkId: "f2",
		});
	});

	test("binding does not mutate frozen inputs", () => {
		expect(() =>
			decideJoinBinding({
				expected: Object.freeze(expected),
				current: Object.freeze(same),
			}),
		).not.toThrow();
	});
});

describe("fork validation and register", () => {
	const item = {
		scopeId: "probe",
		intent: "x",
		budget: { read: 1 },
		time: 30,
		targets: ["src/parser.mjs"],
	};

	test("validateFork normalizes targets and refuses malformed input", () => {
		expect(validateFork(item).ok).toBe(true);
		expect(validateFork({ ...item, intent: "  " }).code).toBe("INVALID_INTENT");
		expect(validateFork({ ...item, budget: { read: -1 } }).code).toBe("INVALID_BUDGET");
		expect(validateFork({ ...item, targets: [] }).code).toBe("INVALID_TARGETS");
		expect(
			validateFork({ ...item, targets: [" src/parser.mjs ", "src/cache.mjs"] }).targets,
		).toEqual(["src/parser.mjs", "src/cache.mjs"]);
	});

	test("decideRegister refuses a duplicate scope id", () => {
		const out = decideRegister({
			items: [validateFork(item)],
			forks: [{ forkId: "f1", scopeId: "probe", status: "running" }],
			hasSpawner: true,
		});
		expect(out.ok).toBe(false);
		expect(out.code).toBe("DUPLICATE_SCOPE_ID");
		expect(out.scopeId).toBe("probe");
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
			receiptChars: 10_000,
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
