import { describe, expect, test } from "bun:test";

import {
	beginGenerationAfterHandoff,
	createRelay,
} from "../../../src/relay/index.mjs";
import {
	decideHandoffAdvance,
	decideHandoffArm,
	decideHandoffReport,
	decideInheritedLedgerViewed,
	decideNaturalStop,
	decideRelayEvaluation,
	decideRetirement,
	decideSelfHandoff,
} from "../../../src/station/domain/handoff.mjs";

const WORK = Object.freeze([{ phase: "Work", items: ["one"] }]);
const EMPTY = Object.freeze([]);

function relay(overrides = {}) {
	return Object.freeze({ ...createRelay(), ...overrides });
}

describe("decideRelayEvaluation", () => {
	test("none owes nothing and keeps the shared answer shape", () => {
		const before = relay();
		const result = decideRelayEvaluation({
			relay: before,
			owesLedger: false,
			phases: WORK,
			op: "init",
		});
		expect(result).toEqual({
			relay: before,
			stats: { empty: true, open: 0, total: 0 },
			action: null,
			changed: false,
			commit: false,
		});
	});

	test("an empty ledger with an unreceived child is held", () => {
		const before = relay();
		const result = decideRelayEvaluation({
			relay: before,
			owesLedger: true,
			phases: EMPTY,
			op: "init",
			unreceived: 2,
			options: { at: 10 },
		});
		expect(result.action).toBe("held");
		expect(result.changed).toBe(false);
		expect(result.unreceived).toBe(2);
		expect(result.commit).toBe(false);
		expect(result.relay).toBe(before);
		expect(before.handoffPending).toBe(false);
	});

	test("generation 0 empty ledger hands off and commits", () => {
		const before = relay();
		const result = decideRelayEvaluation({
			relay: before,
			owesLedger: true,
			phases: EMPTY,
			op: "init",
			options: { at: 10 },
		});
		expect(result.action).toBe("handoff");
		expect(result.relay.handoffPending).toBe(true);
		expect(result.changed).toBe(true);
		expect(result.commit).toBe(true);
		expect(before.handoffPending).toBe(false);
	});

	test("view and errors do not advance but still commit the copy", () => {
		const before = relay();
		const result = decideRelayEvaluation({
			relay: before,
			owesLedger: true,
			phases: WORK,
			op: "view",
			options: { at: 10 },
		});
		expect(result.action).toBeNull();
		expect(result.changed).toBe(false);
		expect(result.commit).toBe(true);
		expect(result.relay).not.toBe(before);
		expect(result.relay.lastLedger).toBeNull();
	});
});

describe("decideRetirement", () => {
	test("none never retires", () => {
		expect(decideRetirement({ relay: relay(), owesLedger: false })).toBeNull();
	});

	test("a non-empty ledger retires and requires the view", () => {
		const result = decideRetirement({
			relay: relay({
				lastLedger: { empty: false, open: 1, total: 1, at: 1 },
			}),
			owesLedger: true,
		});
		expect(result.action).toBe("retire");
		expect(result.changed).toBe(true);
		expect(result.relay.handoffPending).toBe(true);
		expect(result.relay.viewRequired).toBe(true);
	});

	test("a stoppable relay does not retire twice", () => {
		const result = decideRetirement({
			relay: relay({ canStop: true }),
			owesLedger: true,
		});
		expect(result.action).toBeNull();
		expect(result.changed).toBe(false);
	});
});

describe("decideHandoffArm", () => {
	test("arms only a handoff degree on a non-stoppable relay", () => {
		const before = relay({ canStop: false });
		const result = decideHandoffArm({
			relay: before,
			isChild: false,
			canHandoff: true,
		});
		expect(result.arm).toBe(true);
		expect(result.relay.handoffPending).toBe(true);
		expect(before.handoffPending).toBe(false);
	});

	test("children, ledger-only relays, and stoppable relays never arm", () => {
		expect(
			decideHandoffArm({ relay: relay(), isChild: true, canHandoff: true }).arm,
		).toBe(false);
		expect(
			decideHandoffArm({ relay: relay(), isChild: false, canHandoff: false }).arm,
		).toBe(false);
		expect(
			decideHandoffArm({
				relay: relay({ canStop: true }),
				isChild: false,
				canHandoff: true,
			}).arm,
		).toBe(false);
	});
});

describe("decideHandoffAdvance", () => {
	test("advances one generation when the expected generation matches", () => {
		const before = relay({ generation: 2, handoffPending: true, canStop: false });
		const result = decideHandoffAdvance({
			relay: before,
			isChild: false,
			canHandoff: true,
			expectedGeneration: 2,
			at: 100,
		});
		expect(result.advance).toBe(true);
		expect(result.relay.generation).toBe(3);
		expect(result.relay.handoffPending).toBe(false);
		expect(result.relay.lastHandoff.at).toBe(100);
		expect(before.generation).toBe(2);
	});

	test("a stale generation, a child, or a ledger-only relay never advances", () => {
		const before = relay({ generation: 2, handoffPending: true });
		expect(
			decideHandoffAdvance({
				relay: before,
				isChild: false,
				canHandoff: true,
				expectedGeneration: 1,
			}).advance,
		).toBe(false);
		expect(
			decideHandoffAdvance({
				relay: before,
				isChild: true,
				canHandoff: true,
			}).advance,
		).toBe(false);
		expect(
			decideHandoffAdvance({
				relay: before,
				isChild: false,
				canHandoff: false,
			}).advance,
		).toBe(false);
	});
});

describe("decideNaturalStop", () => {
	test("no obligation, manual stop, or child has no plan", () => {
		expect(decideNaturalStop({ relay: relay(), owesLedger: false, autopilot: true })).toBeNull();
		expect(decideNaturalStop({ relay: relay(), owesLedger: true, autopilot: false })).toBeNull();
		expect(decideNaturalStop({ relay: relay(), owesLedger: true, autopilot: true, isChild: true })).toBeNull();
	});

	test("a pending or stoppable relay has no plan", () => {
		expect(
			decideNaturalStop({
				relay: relay({ handoffPending: true }),
				owesLedger: true,
				autopilot: true,
			}),
		).toBeNull();
		expect(
			decideNaturalStop({
				relay: relay({ canStop: true }),
				owesLedger: true,
				autopilot: true,
			}),
		).toBeNull();
	});

	test("generation 0 and a fresh successor take the small handoff", () => {
		expect(
			decideNaturalStop({ relay: relay(), owesLedger: true, autopilot: true }),
		).toEqual({ kind: "retire" });
		const successor = beginGenerationAfterHandoff(relay(), {
			at: 1,
			fromGeneration: 0,
		});
		expect(
			decideNaturalStop({ relay: successor, owesLedger: true, autopilot: true }),
		).toEqual({ kind: "retire" });
	});

	test("an unreceived child withholds every natural-stop submission", () => {
		expect(
			decideNaturalStop({
				relay: relay(),
				owesLedger: true,
				autopilot: true,
				unreceived: 1,
			}),
		).toBeNull();
		const inherited = relay({
			generation: 1,
			firstEvaluation: "nonempty",
			lastLedger: { empty: false, open: 1, total: 1, at: 1 },
		});
		expect(
			decideNaturalStop({
				relay: inherited,
				owesLedger: true,
				autopilot: true,
				unreceived: 1,
			}),
		).toBeNull();
	});

	test("a known non-empty inheritance retires", () => {
		const inherited = relay({
			generation: 1,
			firstEvaluation: "nonempty",
			lastLedger: { empty: false, open: 1, total: 1, at: 1 },
		});
		expect(
			decideNaturalStop({ relay: inherited, owesLedger: true, autopilot: true }),
		).toEqual({ kind: "retire" });
	});
});

describe("decideInheritedLedgerViewed", () => {
	test("clears the view requirement without mutating the input", () => {
		const before = relay({ viewRequired: true });
		const result = decideInheritedLedgerViewed({ relay: before });
		expect(result.relay.viewRequired).toBe(false);
		expect(before.viewRequired).toBe(true);
	});

	test("does nothing when no view is required", () => {
		expect(decideInheritedLedgerViewed({ relay: relay() })).toBeNull();
	});
});

describe("decideHandoffReport", () => {
	test("captures a non-empty report only while a handoff is pending", () => {
		const result = decideHandoffReport({
			relay: relay({ handoffPending: true }),
			isChild: false,
			text: "  report body  ",
		});
		expect(result).toEqual({ capture: true, text: "report body" });
	});

	test("children, no pending handoff, and an empty report do not capture", () => {
		expect(
			decideHandoffReport({
				relay: relay({ handoffPending: true }),
				isChild: true,
				text: "body",
			}).capture,
		).toBe(false);
		expect(
			decideHandoffReport({ relay: relay(), isChild: false, text: "body" }).capture,
		).toBe(false);
		expect(
			decideHandoffReport({
				relay: relay({ handoffPending: true }),
				isChild: false,
				text: "   ",
			}).capture,
		).toBe(false);
	});
});

describe("decideSelfHandoff", () => {
	test("is legal only on a pending, stoppable relay", () => {
		expect(
			decideSelfHandoff({
				relay: relay({ handoffPending: true }),
				isChild: false,
			}),
		).toBe(true);
		expect(
			decideSelfHandoff({
				relay: relay({ handoffPending: true }),
				isChild: true,
			}),
		).toBe(false);
		expect(
			decideSelfHandoff({ relay: relay(), isChild: false }),
		).toBe(false);
		expect(
			decideSelfHandoff({
				relay: relay({ handoffPending: true, canStop: true }),
				isChild: false,
			}),
		).toBe(false);
	});
});
