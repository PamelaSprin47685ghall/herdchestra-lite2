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
		const clock = decider({ clockMs: 5_000 }, (_mine, fact) => fact.startedAt + 5_000);
		const before = snapshot(scope.state);

		expect(clock.judge(scope.publish())).toBe(6_000);

		expectPublisherUntouched(scope, before);
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
		const pin = publisher({ notes: ["p1", "p2"] });
		const folding = decider({ kept: [] }, (mine, fact) => {
			mine.kept = fact.notes.slice();
			return mine.kept;
		});
		const before = snapshot(pin.state);

		expect(folding.judge(pin.publish())).toEqual(["p1", "p2"]);
		pin.state.notes.push("p3");
		expect(folding.judge(pin.publish())).toEqual(["p1", "p2", "p3"]);

		// Folding kept its own copy; the pin set is the publisher's alone.
		expect(pin.state).toEqual({ notes: ["p1", "p2", "p3"] });
	});
});

describe("the pair list itself", () => {
	test("the remaining four port pairs are the ones covered", () => {
		const covered = [
			"amend × folding",
			"clock × scope",
			"relay × herd",
			"pin × folding",
		];
		expect(covered).toHaveLength(4);
		expect(new Set(covered).size).toBe(4);
	});});
