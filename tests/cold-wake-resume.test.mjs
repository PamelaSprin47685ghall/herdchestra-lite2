// A stopped scope answers through a one-shot resume.
//
// The branch outlives the session; the record keeps its leaf as `branchTail`.
// A cold wake must answer the queued request and leave everything else exactly
// as it was: no idle entry, no runtime entry, no change to the record.

import { describe, expect, test } from "bun:test";

import {
	createBracketLedger,
	forkOf,
	registerFork,
	validRecord,
} from "../src/scope/forkjoin.mjs";
import { setRecordFields } from "../src/scope/record-mutation.mjs";
import { COLD_REQUEST_WAKE, coldWakeEntry, pendingAt } from "../src/tools/cold-wake.mjs";
import { resumeBranchSession } from "../host-omp/src/host/branch-session.mjs";

function registered() {
	const ledger = createBracketLedger();
	const out = registerFork(ledger, {
		forkId: "f1",
		ownerId: "root",
		fsm: "task",
		depth: 0,
		budget: { read: 1 },
	});
	expect(out.ok).toBe(true);
	return { ledger, record: forkOf(ledger, "f1") };
}

describe("the persisted branch tail", () => {
	test("a registered record starts without one and accepts a leaf", () => {
		const { record } = registered();
		expect(record.branchTail).toBeNull();
		expect(validRecord("f1", record)).toBe(true);
		expect(setRecordFields(record, { branchTail: "entry-1" })).toBe(true);
		expect(record.branchTail).toBe("entry-1");
		expect(validRecord("f1", record)).toBe(true);
	});

	test("an empty or non-string tail is refused", () => {
		const { record } = registered();
		record.branchTail = "";
		expect(validRecord("f1", record)).toBe(false);
		record.branchTail = 7;
		expect(validRecord("f1", record)).toBe(false);
		record.branchTail = null;
		expect(validRecord("f1", record)).toBe(true);
	});
});

describe("a cold wake", () => {
	test("answers the queue once and tears the session down", async () => {
		let pending = 1;
		let prompts = 0;
		let teardowns = 0;
		const entry = coldWakeEntry({
			prompt: async (text) => {
				expect(text).toBe(COLD_REQUEST_WAKE);
				prompts += 1;
				pending = 0;
			},
			pending: () => pending,
			teardown: () => {
				teardowns += 1;
			},
		});
		await entry.drain();
		expect(prompts).toBe(1);
		expect(teardowns).toBe(1);
		// A later request resumes a fresh session; this entry is spent.
		await entry.drain();
		expect(prompts).toBe(1);
		expect(teardowns).toBe(1);
	});

	test("a queue with nothing in it never prompts", async () => {
		let prompts = 0;
		const entry = coldWakeEntry({
			prompt: async () => {
				prompts += 1;
			},
			pending: () => 0,
		});
		await entry.drain();
		expect(prompts).toBe(0);
	});

	test("pendingAt reads the queue table and tolerates a bare registry", () => {
		expect(pendingAt({ requests: new Map([["/a", [1, 2]]]) }, "/a")).toBe(2);
		expect(pendingAt({ requests: new Map() }, "/a")).toBe(0);
		expect(pendingAt({}, "/a")).toBe(0);
		expect(pendingAt(null, "/a")).toBe(0);
	});
});

describe("resuming a stopped branch", () => {
	test("refuses what it cannot rebuild", async () => {
		expect(await resumeBranchSession({ record: null, owner: {} })).toBeNull();
		expect(await resumeBranchSession({ record: { outcome: "failed" }, owner: {} })).toBeNull();
		expect(await resumeBranchSession({ record: { agentId: null }, owner: {} })).toBeNull();
		expect(await resumeBranchSession({ record: { agentId: "agent-1" }, owner: {} })).toBeNull();
	});
});
