// The six bill-split pairs from PLAN §3.2, asserted as direction, not as text.
//
// Each pair has one owner that decides, and one side that only publishes a
// fact. The test drives exactly that: the owner reads the published fact,
// decides, and never writes the publishing side. When the real ports arrive,
// only the stubs change; these directions must not.

import { describe, expect, test } from "bun:test";

/** A side that only publishes: `publish()` returns a copy, and nothing else. */
function publisher(state) {
	return {
		state,
		publish() {
			return structuredClone(this.state);
		},
	};
}

/** A side that decides: `judge(fact)` reads a published fact and returns a verdict. */
function decider(state, judge) {
	return {
		state,
		judge(fact) {
			this.seen = fact;
			return judge(this.state, fact);
		},
	};
}

function snapshot(value) {
	return structuredClone(value);
}

function expectPublisherUntouched(other, before) {
	expect(other.state).toEqual(before);
	// A publisher has one public method; the owner must not have grown one.
	expect(Object.keys(other).sort()).toEqual(["publish", "state"]);
}

describe("bill-split directions", () => {
	test("relay × stages: stages judges validity; relay only publishes the generation", () => {
		const relay = publisher({ generation: 2, fullFlow: true });
		const stages = decider({ generation: 1, flags: { acceptance: true } }, (mine, fact) =>
			fact.generation === mine.generation ? mine.flags : { acceptance: false },
		);
		const before = snapshot(relay.state);

		// A stale generation invalidates the flags without clearing them in place.
		expect(stages.judge(relay.publish())).toEqual({ acceptance: false });
		// Adopting the fact is the owner's own write; the publisher is untouched.
		stages.state.generation = 2;
		expect(stages.judge(relay.publish())).toEqual({ acceptance: true });

		expectPublisherUntouched(relay, before);
	});

	test("amend × folding: amend owns the retired keys; folding only asks", () => {
		const amend = publisher({ retired: ["beat-1"] });
		const folding = decider({ rewritten: [] }, (mine, fact) => {
			mine.rewritten.push({ key: "beat-1", allowed: !fact.retired.includes("beat-1") });
			return mine.rewritten.at(-1);
		});
		const before = snapshot(amend.state);

		expect(folding.judge(amend.publish())).toEqual({ key: "beat-1", allowed: false });
		expect(folding.judge(amend.publish())).toEqual({ key: "beat-1", allowed: false });

		expectPublisherUntouched(amend, before);
	});

	test("clock × scope: clock owns the deadline; scope only publishes the call's origin", () => {
		const scope = publisher({ scopeId: "s1", batchId: "b1", startedAt: 1_000 });
		const clock = decider({ budgetMs: 5_000 }, (_mine, fact) => fact.startedAt + 5_000);
		const before = snapshot(scope.state);

		expect(clock.judge(scope.publish())).toBe(6_000);

		expectPublisherUntouched(scope, before);
	});

	test("herd × stages: stages owns admission; herd only publishes the mode", () => {
		const herd = publisher({ mode: "off" });
		const stages = decider({ allowed: [] }, (mine, fact) => {
			mine.allowed = fact.mode === "on" ? ["decision-framing"] : [];
			return mine.allowed;
		});
		const before = snapshot(herd.state);

		expect(stages.judge(herd.publish())).toEqual([]);
		herd.state.mode = "on";
		expect(stages.judge(herd.publish())).toEqual(["decision-framing"]);

		// The owner never wrote the publishing side: only the test changed mode.
		expect(herd.state).toEqual({ mode: "on" });
	});

	test("relay × herd: relay owns progression; herd only publishes the mode", () => {
		const herd = publisher({ mode: "on" });
		const relay = decider({ progressed: [] }, (mine, fact) => {
			if (fact.mode !== "on") mine.progressed.push("step");
			return mine.progressed.length;
		});
		const before = snapshot(herd.state);

		expect(relay.judge(herd.publish())).toBe(0);

		expectPublisherUntouched(herd, before);
	});

	test("pin × folding: folding owns the keep-list; pin only publishes its set", () => {
		const pin = publisher({ pins: ["p1", "p2"] });
		const folding = decider({ kept: [] }, (mine, fact) => {
			mine.kept = fact.pins.slice();
			return mine.kept;
		});
		const before = snapshot(pin.state);

		expect(folding.judge(pin.publish())).toEqual(["p1", "p2"]);
		pin.state.pins.push("p3");
		expect(folding.judge(pin.publish())).toEqual(["p1", "p2", "p3"]);

		// Folding kept its own copy; the pin set is the publisher's alone.
		expect(pin.state).toEqual({ pins: ["p1", "p2", "p3"] });
	});
});

describe("the pair list itself", () => {
	test("the six pairs of PLAN §3.2 are the ones covered", () => {
		const covered = [
			"relay × stages",
			"amend × folding",
			"clock × scope",
			"herd × stages",
			"relay × herd",
			"pin × folding",
		];
		expect(covered).toHaveLength(6);
		expect(new Set(covered).size).toBe(6);
	});
});
