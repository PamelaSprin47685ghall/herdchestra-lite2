// One call, one debt.
//
// A `js` beat can be replayed: the model retries a call, a ticket is
// re-entered, a host re-executes the same tool call. The budget must be spent
// once per call id, or a retried read quietly eats a turn the branch never got.
//
// The dedupe table is in memory and keyed by the ledger, deliberately: a field
// on the record would be serialized, and a reload rebuilds the bill from the
// budget anyway. These tests pin both halves — the spend is refused twice, and
// nothing about the dedupe appears in a persisted snapshot.

import { expect, test } from "bun:test";

import { chargeBranch } from "../src/scope/accounting.mjs";
import { createBracketLedger, registerFork } from "../src/scope/ledger-brackets.mjs";
import { forkOf } from "../src/scope/ledger-charge.mjs";
import { serializeState } from "../src/scope/state-codec.mjs";
import { createState } from "../src/scope/state.mjs";

function ledgerWith(budget = { bash: 3 }) {
	const ledger = createBracketLedger();
	const registered = registerFork(ledger, {
		forkId: "alpha",
		ownerId: "root",
		levelKey: "root|0|0",
		fsm: "work alpha",
		depth: 0,
		budget,
		startedAt: 1_000,
	});
	expect(registered.ok).toBe(true);
	return ledger;
}

function charge(ledger, overrides = {}) {
	return chargeBranch({}, ledger, {
		ownerId: "alpha",
		toolCallId: "beat#0",
		toolName: "bash",
		groupKey: "beat",
		input: { command: "ls" },
		...overrides,
	});
}

test("a replayed call id spends the budget once", () => {
	const ledger = ledgerWith();
	const record = forkOf(ledger, "alpha");

	const first = charge(ledger);
	expect(first.ok).toBe(true);
	expect(first.amount).toBe(1);
	expect(record.remaining.bash).toBe(2);
	expect(record.spent.bash).toBe(1);

	const replay = charge(ledger);
	expect(replay.ok).toBe(true);
	expect(replay.alreadyCharged).toBe(true);
	expect(replay.amount).toBe(0);
	expect(record.remaining.bash).toBe(2);
	expect(record.spent.bash).toBe(1);
});

test("a different call id is a different debt", () => {
	const ledger = ledgerWith();
	const record = forkOf(ledger, "alpha");

	expect(charge(ledger, { toolCallId: "beat#0" }).amount).toBe(1);
	expect(charge(ledger, { toolCallId: "beat#1" }).amount).toBe(1);
	expect(record.remaining.bash).toBe(1);
	expect(record.spent.bash).toBe(2);
});

test("a replay answers before the budget does", () => {
	// The branch has spent everything since the first call. A second charge
	// would now be refused, so a dedupe that ran after the budget check would
	// turn a settled call into BUDGET_EXHAUSTED and, one layer up, into a
	// panhandle the branch never earned.
	const ledger = ledgerWith({ bash: 1 });
	const record = forkOf(ledger, "alpha");

	const first = charge(ledger);
	expect(first.ok).toBe(true);
	expect(record.remaining.bash).toBe(0);

	const replay = charge(ledger);
	expect(replay.ok).toBe(true);
	expect(replay.alreadyCharged).toBe(true);
	expect(replay.code).toBeUndefined();
	expect(record.panhandleTotal ?? 0).toBe(0);
});

test("the same call id on two branches is two debts", () => {
	// Inner call ids repeat across scopes: each `js` beat numbers its own
	// calls from zero. A key that ignored the branch would let the second
	// scope's first read free-ride on the first scope's.
	const ledger = ledgerWith();
	expect(
		registerFork(ledger, {
			forkId: "beta",
			ownerId: "root",
			levelKey: "root|0|1",
			fsm: "work beta",
			depth: 0,
			budget: { bash: 3 },
			startedAt: 1_000,
		}).ok,
	).toBe(true);

	expect(charge(ledger).amount).toBe(1);
	expect(charge(ledger, { ownerId: "beta" }).amount).toBe(1);
	expect(forkOf(ledger, "alpha").remaining.bash).toBe(2);
	expect(forkOf(ledger, "beta").remaining.bash).toBe(2);
});

test("an unnamed call is charged every time", () => {
	// Nothing to recognise a replay by, so the charge stands — the old
	// `charges` table keyed on the id and behaved the same way.
	const ledger = ledgerWith();
	expect(charge(ledger, { toolCallId: undefined }).amount).toBe(1);
	expect(charge(ledger, { toolCallId: undefined }).amount).toBe(1);
	expect(forkOf(ledger, "alpha").remaining.bash).toBe(1);
});

test("neither the snapshot nor the ledger carries the dedupe table", () => {
	const ledger = ledgerWith();
	charge(ledger);

	// A stored key would make the table a persisted field; it must not be one.
	expect(Object.keys(ledger)).not.toContain("charges");
	expect(JSON.stringify(ledger)).not.toContain("beat#0");

	const snapshot = serializeState({ ...createState(), brackets: ledger });
	expect(JSON.stringify(snapshot)).not.toContain("beat#0");
	// The tree still passed validation: a ledger mangled by bookkeeping would
	// have been replaced by an empty one.
	expect(snapshot.brackets.forks.alpha).toBeDefined();
});
