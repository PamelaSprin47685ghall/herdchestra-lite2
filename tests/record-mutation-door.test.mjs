// The write door: a record change and its mark are one operation.
//
// The clock and the return allowance write fields on a record they did not
// create. A snapshot copies only the records it believes have moved, so a write
// that forgets the mark is invisible: the value changes in memory, the journal
// keeps the old copy, and a reload shows it with no error anywhere. These cases
// drive the real exports against a real ledger and assert the mark, because the
// mark is the only reason the write is observable at all.

import { describe, expect, test } from "bun:test";

import { editRecord, setRecordFields } from "../src/scope/record-mutation.mjs";
import { createBracketLedger, registerFork } from "../src/scope/ledger-brackets.mjs";
import { forkOf } from "../src/scope/ledger-charge.mjs";
import { ledgerMeta } from "../src/scope/ledger-cache.mjs";
import {
	createClockOn,
	createClockOff,
	pauseClock,
	resumeClock,
	toolLimitOf,
} from "../src/scope/clock.mjs";
import {
	MAX_RETURN_NUDGES,
	returnNudgesOf,
	takeReturnNudge,
	resetReturnNudges,
} from "../src/scope/return-nudge.mjs";

function ledgerWithRecord(forkId = "fork_a") {
	const ledger = createBracketLedger();
	const registered = registerFork(ledger, {
		forkId,
		ownerId: "root",
		fsm: "one state",
		depth: 0,
		budget: { read: 1 },
		profession: "You are a tester.",
	});
	expect(registered.ok).toBe(true);
	const record = forkOf(ledger, forkId);
	// A baseline write clears the marks, so each case starts from "nothing owed".
	ledgerMeta(ledger).dirtyForks.clear();
	return { ledger, record };
}

function marked(ledger, forkId = "fork_a") {
	return ledgerMeta(ledger).dirtyForks.has(forkId);
}

describe("editRecord", () => {
	test("a mutation is marked", () => {
		const { ledger, record } = ledgerWithRecord();
		expect(marked(ledger)).toBe(false);
		expect(editRecord(record, (target) => { target.task = "edited"; })).toBe(true);
		expect(record.task).toBe("edited");
		expect(marked(ledger)).toBe(true);
	});

	test("a damaged fork id does not redirect its owner's dirty mark", () => {
		const { ledger, record } = ledgerWithRecord();
		expect(() => editRecord(record, (target) => {
			target.forkId = "incorrect-id";
			throw new Error("partial edit");
		})).toThrow("partial edit");
		expect(marked(ledger, "fork_a")).toBe(true);
		expect(marked(ledger, "incorrect-id")).toBe(false);
	});

	test("a partially changed record is marked when an edit throws", () => {
		const { ledger, record } = ledgerWithRecord();
		const failure = new Error("edit failed");
		expect(() => editRecord(record, (target) => {
			target.task = "partially changed";
			throw failure;
		})).toThrow(failure);
		expect(record.task).toBe("partially changed");
		expect(marked(ledger)).toBe(true);
	});

	test("an edit that reports no change writes no mark", () => {
		const { ledger, record } = ledgerWithRecord();
		expect(
			editRecord(record, () => false),
		).toBe(false);
		expect(marked(ledger)).toBe(false);
	});

	test("a missing record is not an error and writes no mark", () => {
		expect(editRecord(null, () => {})).toBe(false);
		expect(editRecord(undefined, () => {})).toBe(false);
		expect(editRecord("record", () => {})).toBe(false);
	});

	test("setRecordFields keeps the record's own values when they already match", () => {
		const { ledger, record } = ledgerWithRecord();
		record.deadlineAt = null;
		ledgerMeta(ledger).dirtyForks.clear();

		// Asking for the state the record already has is not a change: a mark
		// here would rewrite the record for nothing on every write.
		expect(setRecordFields(record, { deadlineAt: null })).toBe(false);
		expect(marked(ledger)).toBe(false);

		expect(setRecordFields(record, { deadlineAt: 1234 })).toBe(true);
		expect(record.deadlineAt).toBe(1234);
		expect(marked(ledger)).toBe(true);
	});
});

describe("clock writes through the door", () => {
	test("pausing a bounded clock is stored", () => {
		const { ledger, record } = ledgerWithRecord();
		record.deadlineAt = 10_000;
		ledgerMeta(ledger).dirtyForks.clear();

		expect(pauseClock(record, 1_000)).toBe(true);
		expect(record.clockPausedAt).toBe(1_000);
		expect(marked(ledger)).toBe(true);
	});

	test("a second pause is refused and changes nothing", () => {
		const { ledger, record } = ledgerWithRecord();
		record.deadlineAt = 10_000;
		record.clockPausedAt = 1_000;
		ledgerMeta(ledger).dirtyForks.clear();

		expect(pauseClock(record, 2_000)).toBe(false);
		expect(record.clockPausedAt).toBe(1_000);
		expect(marked(ledger)).toBe(false);
	});

	test("resuming shifts the deadline by the paused span", () => {
		const { ledger, record } = ledgerWithRecord();
		record.deadlineAt = 10_000;
		record.clockPausedAt = 1_000;
		ledgerMeta(ledger).dirtyForks.clear();

		expect(resumeClock(record, 3_500)).toBe(true);
		expect(record.deadlineAt).toBe(12_500);
		expect(record.pausedMs).toBe(2_500);
		expect(record.clockPausedAt).toBeNull();
		expect(marked(ledger)).toBe(true);
	});

	test("starting a bounded clock stores the deadline", () => {
		const { ledger, record } = ledgerWithRecord();
		const clock = createClockOn(() => 0);

		expect(clock.start(record, 5_000, 100)).toEqual({ ok: true, deadlineAt: 5_100 });
		expect(record.deadlineAt).toBe(5_100);
		expect(marked(ledger)).toBe(true);
	});

	test("an invalid budget clears the clock and stores that too", () => {
		const { ledger, record } = ledgerWithRecord();
		record.deadlineAt = 9_999;
		ledgerMeta(ledger).dirtyForks.clear();

		const result = createClockOn(() => 0).start(record, 0, 0);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("CLOCK_INVALID_BUDGET");
		// The cleared bound has to reach the journal: a reload that kept 9_999
		// would report a deadline nobody set.
		expect(record.deadlineAt).toBeNull();
		expect(marked(ledger)).toBe(true);
	});

	test("an unbounded clock clears whatever bound the record carried", () => {
		const { ledger, record } = ledgerWithRecord();
		record.deadlineAt = 7_000;
		record.overtimeAt = 6_000;
		ledgerMeta(ledger).dirtyForks.clear();

		expect(createClockOff().start(record)).toEqual({ ok: true });
		expect(record.deadlineAt).toBeNull();
		expect(record.overtimeAt).toBeNull();
		expect(marked(ledger)).toBe(true);
	});

	test("the first overrun stamps the record once", () => {
		const { ledger, record } = ledgerWithRecord();
		record.deadlineAt = 1_000;
		ledgerMeta(ledger).dirtyForks.clear();

		expect(toolLimitOf(record, 2_000)).toBeNull();
		expect(record.overtimeAt).toBe(2_000);
		expect(marked(ledger)).toBe(true);

		// The stamp is the first overrun only; a later call must not move it.
		ledgerMeta(ledger).dirtyForks.clear();
		toolLimitOf(record, 3_000);
		expect(record.overtimeAt).toBe(2_000);
		expect(marked(ledger)).toBe(false);
	});
});

describe("the return allowance writes through the door", () => {
	test("charging a nudge is stored, and the bound still holds", () => {
		const { ledger, record } = ledgerWithRecord();
		ledgerMeta(ledger).dirtyForks.clear();

		expect(takeReturnNudge(record)).toBe(true);
		expect(returnNudgesOf(record)).toBe(1);
		expect(marked(ledger)).toBe(true);

		expect(takeReturnNudge(record)).toBe(true);
		expect(returnNudgesOf(record)).toBe(MAX_RETURN_NUDGES);

		ledgerMeta(ledger).dirtyForks.clear();
		expect(takeReturnNudge(record)).toBe(false);
		expect(returnNudgesOf(record)).toBe(MAX_RETURN_NUDGES);
		expect(marked(ledger)).toBe(false);
	});

	test("resetting the allowance is stored", () => {
		const { ledger, record } = ledgerWithRecord();
		record.returnNudges = 2;
		ledgerMeta(ledger).dirtyForks.clear();

		expect(resetReturnNudges(record)).toBeUndefined();
		expect(returnNudgesOf(record)).toBe(0);
		expect(marked(ledger)).toBe(true);
	});

	test("resetting a record that has no allowance still records the fact", () => {
		const { ledger, record } = ledgerWithRecord();
		ledgerMeta(ledger).dirtyForks.clear();
		// Written unconditionally: a reset opens a new requirement, and the
		// journal has to hold that even when the value already matched.
		expect(resetReturnNudges(record)).toBeUndefined();
		expect(marked(ledger)).toBe(true);
	});
});
