// Regression: the real `observeActualModel` must run to completion.
//
// This function appears in the gates path twice, and two suites replace it
// with a stub, so for a while the real body was never executed by any test. It
// carried an undeclared `state` that threw `ReferenceError` after it had
// already written `usage.lastCtxModel` — a crash in a half-updated station
// that a green suite could not see, because `node --check` treats an
// undeclared identifier as valid syntax and the lint config leaves `no-undef`
// off.
//
// The double below is the smallest station the body can run against: one live
// model, a usage ledger that counts its refresh, and the state fields the
// body's early returns read. Every assertion is about a side effect the body
// promises, not about its internals.

import { describe, expect, test } from "bun:test";
import { observeActualModel } from "../src/station/models.mjs";

/** A station double that records what the body did. */
function stationWith(live = { id: "m", provider: "p", contextWindow: 1000 }) {
	const calls = { refresh: 0, persist: 0 };
	const station = {
		// A non-empty value skips the capability probe, which is host work the
		// body only does once.
		hostCapabilities: {},
		host: { model: { of: () => live, thinkingOf: () => null } },
		usage: {
			lastCtxModel: null,
			refreshContextNudge() {
				calls.refresh += 1;
			},
		},
		state: {
			modelRecovery: null,
			baseModelKey: null,
			baseModelSpec: null,
		},
		// The rewind value and the one accessor the free functions read.
		rewind: { modelSwitch: null, modelSwitchInFlight: null },
		rewindState() {
			return this.rewind;
		},
		persist() {
			calls.persist += 1;
		},
	};
	return { station, calls, live };
}

describe("observeActualModel regression", () => {
	test("records the live model, its key, and refreshes the nudge once", () => {
		const { station, calls, live } = stationWith();

		observeActualModel(station, {});

		expect(station.usage.lastCtxModel).toBe(live);
		expect(station.state.baseModelKey).toBe("p/m");
		expect(station.state.baseModelSpec).toBe("p/m");
		// The nudge is re-read against the window this model carries, so a
		// model switch cannot leave the verdict describing an older limit.
		expect(calls.refresh).toBe(1);
		expect(calls.persist).toBe(1);
	});

	test("the same model again refreshes but does not re-persist", () => {
		const { station, calls } = stationWith();
		observeActualModel(station, {});
		observeActualModel(station, {});

		// Every request re-reads the flag; only a change in the recorded model
		// is worth a write.
		expect(calls.refresh).toBe(2);
		expect(calls.persist).toBe(1);
	});

	test("a model switch re-records and persists the new key", () => {
		const calls = { refresh: 0, persist: 0 };
		let live = { id: "a", provider: "p", contextWindow: 1000 };
		const station = {
			hostCapabilities: {},
			host: { model: { of: () => live, thinkingOf: () => null } },
			usage: {
				lastCtxModel: null,
				refreshContextNudge() {
					calls.refresh += 1;
				},
			},
			state: { modelRecovery: null, baseModelKey: null, baseModelSpec: null },
			rewind: { modelSwitch: null, modelSwitchInFlight: null },
			rewindState() {
				return this.rewind;
			},
			persist() {
				calls.persist += 1;
			},
		};

		observeActualModel(station, {});
		live = { id: "b", provider: "p", contextWindow: 2000 };
		observeActualModel(station, {});

		expect(station.usage.lastCtxModel.id).toBe("b");
		// The window moved with the model, and the flag was re-read both times.
		expect(station.usage.lastCtxModel.contextWindow).toBe(2000);
		expect(station.state.baseModelKey).toBe("p/b");
		expect(calls.refresh).toBe(2);
		expect(calls.persist).toBe(2);
	});

	test("a pending switch keeps the recorded model and skips the write", () => {
		const { station, calls } = stationWith();
		station.rewind.modelSwitch = { command: "/switch x" };
		observeActualModel(station, {});

		// The live model is still recorded, but a switch in flight owns the
		// choice and the key stays untouched.
		expect(station.usage.lastCtxModel.provider).toBe("p");
		expect(station.state.baseModelKey).toBeNull();
		expect(calls.refresh).toBe(1);
		expect(calls.persist).toBe(0);
	});

	test("a model without an identity is never recorded", () => {
		const { station, calls } = stationWith({ provider: "p" });
		observeActualModel(station, {});

		expect(station.usage.lastCtxModel).toBeNull();
		expect(calls.refresh).toBe(0);
		expect(calls.persist).toBe(0);
	});
});
