// The fork/join domain is pure: plain snapshots in, plain decisions out.
// These cases pin the consumer-visible edges the handlers rely on.

import { describe, expect, test } from "bun:test";

import {
	decideForkAdmission,
	decideJoinAdmission,
	decideJoinBinding,
	decidePendingReport,
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
