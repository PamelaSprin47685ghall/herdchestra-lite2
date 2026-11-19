import { describe, expect, test } from "bun:test";
import { createState, deserializeState, serializeState } from "../src/scope/index.mjs";
import {
	applyLedgerEvaluation,
	beginGenerationAfterHandoff,
	createRelay,
	handoffFailureNudge,
	handoffFocus,
	invalidatePromotion,
	ledgerStats,
	recordHandoffFailure,
	relayStatusText,
} from "../src/relay/index.mjs";

function phases(tasks) {
	return [{ name: "P", tasks }];
}

function openTask(content, status = "pending") {
	return { content, status };
}

describe("ledgerStats", () => {
	test("treats empty phases as an empty ledger", () => {
		expect(ledgerStats([])).toEqual({
			empty: true,
			open: 0,
			blocked: 0,
			completed: 0,
			abandoned: 0,
			total: 0,
		});
		expect(ledgerStats(null).empty).toBe(true);
	});

	test("counts pending and in_progress as open, blocked as open and blocked", () => {
		const stats = ledgerStats(
			phases([
				openTask("a", "pending"),
				openTask("b", "in_progress"),
				openTask("c", "blocked"),
				openTask("d", "completed"),
				openTask("e", "abandoned"),
			]),
		);
		expect(stats).toEqual({
			empty: false,
			open: 3,
			blocked: 1,
			completed: 1,
			abandoned: 1,
			total: 5,
		});
	});

	test("accepts the init argument shape with phase and items", () => {
		const stats = ledgerStats([{ phase: "P", items: ["one", "two"] }]);
		expect(stats.total).toBe(2);
		expect(stats.open).toBe(2);
		expect(stats.empty).toBe(false);
	});

	test("ignores malformed phases and tasks", () => {
		expect(ledgerStats([null, {}, { tasks: [null, "x"] }])).toEqual({
			empty: false,
			open: 1,
			blocked: 0,
			completed: 0,
			abandoned: 0,
			total: 1,
		});
	});
});

describe("applyLedgerEvaluation", () => {
	test("generation 0 empty ledger must hand off, never stop", () => {
		const result = applyLedgerEvaluation(createRelay(), [], {
			op: "init",
			at: 10,
		});
		expect(result.action).toBe("handoff");
		expect(result.relay.handoffPending).toBe(true);
		expect(result.relay.canStop).toBe(false);
		expect(result.relay.firstEvaluation).toBe("empty");
		expect(result.relay.lastLedger).toEqual({
			empty: true,
			open: 0,
			blocked: 0,
			completed: 0,
			abandoned: 0,
			total: 0,
			at: 10,
		});
	});

	test("generation 0 first non-empty ledger enters rework", () => {
		const result = applyLedgerEvaluation(
			createRelay(),
			phases([openTask("open")]),
			{ op: "init", at: 11 },
		);
		expect(result.action).toBe("rework");
		expect(result.relay.firstEvaluation).toBe("nonempty");
		expect(result.relay.canStop).toBe(false);
		expect(result.relay.handoffPending).toBe(false);
	});

	test("generation 1 first empty ledger promotes and allows a stop", () => {
		let relay = beginGenerationAfterHandoff(createRelay(), {
			at: 1,
			fromGeneration: 0,
		});
		const result = applyLedgerEvaluation(relay, [], { op: "init", at: 2 });
		expect(result.action).toBe("promoted");
		expect(result.relay.canStop).toBe(true);
		expect(result.relay.handoffPending).toBe(false);
		expect(result.relay.firstEvaluation).toBe("empty");
		expect(result.relay.generation).toBe(1);
	});

	test("generation 1 first non-empty ledger is rework, then empty still hands off", () => {
		const relay = beginGenerationAfterHandoff(createRelay(), {
			at: 1,
			fromGeneration: 0,
		});
		const rework = applyLedgerEvaluation(relay, phases([openTask("open")]), {
			op: "init",
			at: 2,
		});
		expect(rework.action).toBe("rework");
		expect(rework.relay.firstEvaluation).toBe("nonempty");
		expect(rework.relay.canStop).toBe(false);

		const laterEmpty = applyLedgerEvaluation(rework.relay, [], {
			op: "init",
			at: 3,
		});
		expect(laterEmpty.action).toBe("handoff");
		expect(laterEmpty.relay.canStop).toBe(false);
		expect(laterEmpty.relay.handoffPending).toBe(true);
		expect(laterEmpty.relay.firstEvaluation).toBe("nonempty");
	});

	test("a promoted successor that reports open work loses canStop", () => {
		const promoted = applyLedgerEvaluation(
			beginGenerationAfterHandoff(createRelay(), { at: 1, fromGeneration: 0 }),
			[],
			{ op: "init", at: 2 },
		);
		expect(promoted.relay.canStop).toBe(true);
		const nonEmpty = applyLedgerEvaluation(
			promoted.relay,
			phases([openTask("open")]),
			{ op: "append", at: 3 },
		);
		expect(nonEmpty.action).toBe("continue");
		expect(nonEmpty.relay.canStop).toBe(false);
		expect(nonEmpty.relay.promotionInvalidated).toBe(true);
	});

	test("view and errors never advance the relay", () => {
		const view = applyLedgerEvaluation(createRelay(), [], {
			op: "view",
			at: 1,
		});
		expect(view.action).toBeNull();
		expect(view.changed).toBe(false);
		expect(view.relay).toEqual(createRelay());

		const failed = applyLedgerEvaluation(createRelay(), [], {
			isError: true,
			op: "init",
			at: 1,
		});
		expect(failed.action).toBeNull();
		expect(failed.relay).toEqual(createRelay());
	});
});

describe("handoff transitions", () => {
	test("beginGenerationAfterHandoff resets promotion state and records success", () => {
		const next = beginGenerationAfterHandoff(
			{ ...createRelay(), firstEvaluation: "empty", canStop: true, handoffPending: true },
			{ at: 42, fromGeneration: 0 },
		);
		expect(next.generation).toBe(1);
		expect(next.firstEvaluation).toBeNull();
		expect(next.canStop).toBe(false);
		expect(next.handoffPending).toBe(false);
		expect(next.promotionInvalidated).toBe(false);
		expect(next.lastHandoff).toEqual({
			at: 42,
			fromGeneration: 0,
			ok: true,
		});
	});

	test("invalidatePromotion clears canStop and marks the promotion invalid", () => {
		const relay = invalidatePromotion({
			...createRelay(),
			generation: 1,
			canStop: true,
		});
		expect(relay.canStop).toBe(false);
		expect(relay.promotionInvalidated).toBe(true);
	});

	test("invalidatePromotion is a no-op before promotion so successor audit scopes never block promotion", () => {
		const relay = beginGenerationAfterHandoff(createRelay(), { at: 42, fromGeneration: 0 });
		const afterAuditScope = invalidatePromotion(relay);
		expect(afterAuditScope.promotionInvalidated).toBe(false);
		const evaluated = applyLedgerEvaluation(afterAuditScope, [], { op: "init", at: 43 });
		expect(evaluated.action).toBe("promoted");
		expect(evaluated.relay.canStop).toBe(true);
	});

	test("recordHandoffFailure clears pending, keeps the error, and stays retryable", () => {
		const relay = recordHandoffFailure(
			{ ...createRelay(), handoffPending: true },
			new Error("session unavailable"),
			{ at: 7 },
		);
		expect(relay.handoffPending).toBe(false);
		expect(relay.handoffError).toBe("session unavailable");
		expect(relay.lastHandoff).toEqual({
			at: 7,
			fromGeneration: 0,
			ok: false,
			error: "session unavailable",
		});
		expect(relay.canStop).toBe(false);
	});
});

describe("relay text", () => {
	test("status names the generation, first evaluation, ledger, and next step", () => {
		const promoted = applyLedgerEvaluation(
			beginGenerationAfterHandoff(createRelay(), { at: 1, fromGeneration: 0 }),
			[],
			{ op: "init", at: 2 },
		);
		const text = relayStatusText(promoted.relay, promoted.stats, {
			action: promoted.action,
		});
		expect(text).toContain("RELAY STATE");
		expect(text).toContain("Generation: 1 (successor)");
		expect(text).toContain("First todo evaluation of this generation: empty ledger");
		expect(text).toContain("Ledger: empty");
		expect(text).toContain("Can stop now: yes");
		expect(text).toContain("promotion");
	});

	test("handoff text carries the relay rules in English", () => {
		const relay = { ...createRelay(), generation: 2 };
		expect(handoffFocus(relay)).toContain(
			"The successor may first open any number of scopes to investigate",
		);
		expect(handoffFocus(relay)).toContain(
			"Only a successor whose first todo evaluation is an empty ledger may stop naturally",
		);
		expect(handoffFocus(relay)).toContain("An empty ledger triggers a relay handoff");
		expect(handoffFocus(relay)).toContain(
			"only when B's first todo evaluation is empty is stopping allowed",
		);
		expect(handoffFailureNudge("boom")).toContain("HANDOFF FAILED: boom");
	});

	test("the handoff argument demands an independent audit", () => {
		const relay = { ...createRelay(), generation: 2 };
		const texts = [handoffFocus(relay)];
		for (const text of texts) {
			expect(text).toContain(
				"You must independently verify the previous holder's work. Do not trust its empty ledger or its conclusion.",
			);
			expect(text).toContain(
				"Re-read the user's original request; inspect the repository, the actual diff, and the tests.",
			);
			expect(text).toContain(
				"Run the relevant tests yourself; look for omitted, stubbed, falsely marked-complete, or silently narrowed work.",
			);
			expect(text).toContain(
				"An empty ledger is a claim to audit, not evidence. If you find any gap, write it into todo and rework.",
			);
			expect(text).toContain(
				"Summarize the user's requirements without omitting or narrowing them.",
			);
			expect(text).toContain(
				"You do not need to quote the original wording in the ledger or handoff summary.",
			);
		}
	});
});

describe("state version migration", () => {
	test("migrates a valid version 1 state and adds a fresh relay", () => {
		const legacy = {
			version: 1,
			seq: 3,
			scopes: [],
			charges: {},
			regrets: [],
			collapses: [],
		};
		const migrated = deserializeState(legacy);
		expect(migrated.version).toBe(2);
		expect(migrated.seq).toBe(3);
		expect(migrated.relay).toEqual(createState().relay);
	});

	test("serializes and restores relay progress", () => {
		const state = createState();
		state.relay = {
			...state.relay,
			generation: 2,
			firstEvaluation: "nonempty",
			lastLedger: {
				empty: false,
				open: 1,
				blocked: 0,
				completed: 2,
				abandoned: 0,
				total: 3,
				at: 99,
			},
		};
		const payload = serializeState(state);
		expect(payload.relay.generation).toBe(2);
		expect(deserializeState(JSON.parse(JSON.stringify(payload)))).toEqual(state);
	});

	test("rejects a version 2 state with a corrupt relay", () => {
		const payload = serializeState(createState());
		expect(deserializeState({ ...payload, relay: { generation: 0 } })).toEqual(
			createState(),
		);
		expect(deserializeState({ ...payload, relay: null })).toEqual(createState());
	});
});
