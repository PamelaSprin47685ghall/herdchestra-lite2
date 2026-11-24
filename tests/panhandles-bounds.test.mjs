// A branch that panhandles for a long time must not grow its record forever.
//
// The contract has two halves and they must both hold at once:
//   - the count is cumulative, because the parent reads "panhandled Nx" and a
//     branch that admitted 50 calls must say 50, not 16;
//   - the entries are a bounded window, because each entry used to live on the
//     record and in every persisted snapshot for the rest of the session.
//
// The window also carries the retry dedupe. So the tests pin what the window
// can still do, and the one thing it gives up.

import { describe, expect, test } from "bun:test";

import {
	MAX_PANHANDLES,
	notePanhandled,
	panhandleCount,
} from "../src/scope/panhandle.mjs";

function record() {
	return { forkId: "worker", status: "running" };
}

describe("the panhandle entry list is a bounded window", () => {
	test("50 admissions keep 16 entries and report 50", () => {
		const branch = record();
		const tools = ["read", "edit", "bash"];
		for (let index = 0; index < 50; index += 1) {
			const result = notePanhandled(branch, tools[index % 3], {
				now: 1_000 + index,
				callId: `call-${index}`,
			});
			expect(result.ok).toBe(true);
			expect(result.count).toBe(index + 1);
		}

		expect(branch.panhandles).toHaveLength(MAX_PANHANDLES);
		expect(branch.panhandleTotal).toBe(50);
		expect(branch.panhandleTools).toEqual(["read", "edit", "bash"]);
		expect(panhandleCount(branch)).toEqual({
			count: 50,
			tools: ["read", "edit", "bash"],
		});
	});

	test("the window keeps the most recent admissions, not the first", () => {
		const branch = record();
		for (let index = 0; index < 30; index += 1) {
			notePanhandled(branch, "read", { now: 1_000 + index, callId: `call-${index}` });
		}

		expect(branch.panhandles.map((entry) => entry.callId)).toEqual(
			Array.from({ length: MAX_PANHANDLES }, (_, offset) => `call-${14 + offset}`),
		);
	});

	test("an entry carries the same shape it always did", () => {
		const branch = record();
		notePanhandled(branch, "grep", { now: 2_000, callId: "call-1" });
		notePanhandled(branch, "bash", { now: 2_500 });

		expect(branch.panhandles).toEqual([
			{ at: 2_000, tool: "grep", callId: "call-1" },
			{ at: 2_500, tool: "bash" },
		]);
	});
});

describe("retry dedupe still holds inside the window", () => {
	test("the same call twice is one admission and one entry", () => {
		const branch = record();
		notePanhandled(branch, "read", { now: 1_000, callId: "call-1" });
		const again = notePanhandled(branch, "read", { now: 1_100, callId: "call-1" });

		expect(again.ok).toBe(true);
		expect(again.count).toBe(1);
		expect(branch.panhandles).toHaveLength(1);
		expect(branch.panhandleTotal).toBe(1);
	});

	test("dedupe still works after the window has trimmed", () => {
		const branch = record();
		for (let index = 0; index < 20; index += 1) {
			notePanhandled(branch, "read", { now: 1_000 + index, callId: `call-${index}` });
		}
		const again = notePanhandled(branch, "read", { now: 2_000, callId: "call-19" });

		expect(again.count).toBe(20);
		expect(branch.panhandleTotal).toBe(20);
		expect(branch.panhandles).toHaveLength(MAX_PANHANDLES);
	});

	test("a call id that has left the window counts again, and only then", () => {
		const branch = record();
		for (let index = 0; index < MAX_PANHANDLES + 1; index += 1) {
			notePanhandled(branch, "read", { now: 1_000 + index, callId: `call-${index}` });
		}

		// `call-0` fell out when `call-16` arrived; its retry is a new entry.
		const replayed = notePanhandled(branch, "read", { now: 2_000, callId: "call-0" });
		expect(replayed.count).toBe(MAX_PANHANDLES + 2);
		expect(branch.panhandleTotal).toBe(MAX_PANHANDLES + 2);
	});
});

describe("a record from an older snapshot keeps its history", () => {
	function legacy(entries) {
		return { forkId: "worker", status: "joined", panhandles: entries };
	}

	test("panhandleCount reads entries when no counters exist", () => {
		const branch = legacy([
			{ at: 1, tool: "read", callId: "a" },
			{ at: 2, tool: "edit", callId: "b" },
			{ at: 3, tool: "read", callId: "c" },
		]);

		expect(panhandleCount(branch)).toEqual({ count: 3, tools: ["read", "edit"] });
		expect(branch.panhandleTotal).toBeUndefined();
		expect(branch.panhandleTools).toBeUndefined();
	});

	test("the next admission seeds both counters from the old entries", () => {
		const branch = legacy([
			{ at: 1, tool: "read", callId: "a" },
			{ at: 2, tool: "edit", callId: "b" },
		]);

		const result = notePanhandled(branch, "bash", { now: 4_000, callId: "c" });

		expect(result.count).toBe(3);
		expect(branch.panhandleTotal).toBe(3);
		expect(branch.panhandleTools).toEqual(["read", "edit", "bash"]);
		expect(branch.panhandles).toHaveLength(3);
		expect(panhandleCount(branch)).toEqual({
			count: 3,
			tools: ["read", "edit", "bash"],
		});
	});

	test("a legacy record already past the window trims on its next admission", () => {
		const entries = Array.from({ length: 40 }, (_, index) => ({
			at: index,
			tool: "read",
			callId: `call-${index}`,
		}));
		const branch = legacy(entries);

		const result = notePanhandled(branch, "edit", { now: 9_000, callId: "new" });

		expect(result.count).toBe(41);
		expect(branch.panhandleTotal).toBe(41);
		expect(branch.panhandles).toHaveLength(MAX_PANHANDLES);
		expect(branch.panhandles.at(-1)).toEqual({
			at: 9_000,
			tool: "edit",
			callId: "new",
		});
	});

	test("a legacy retry is still one admission", () => {
		const branch = legacy([
			{ at: 1, tool: "read", callId: "a" },
			{ at: 2, tool: "edit", callId: "b" },
		]);

		const again = notePanhandled(branch, "edit", { now: 5_000, callId: "b" });

		expect(again.count).toBe(2);
		expect(branch.panhandles).toHaveLength(2);
		expect(branch.panhandleTotal).toBe(2);
	});

	test("a record that never panhandled reports zero", () => {
		expect(panhandleCount({ forkId: "worker" })).toEqual({ count: 0, tools: [] });
		expect(panhandleCount(null)).toEqual({ count: 0, tools: [] });
	});
});
