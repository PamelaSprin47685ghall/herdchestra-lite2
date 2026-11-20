import { describe, expect, test } from "bun:test";
import { findActivePools } from "../src/scope/accounting.mjs";
import { SessionStation } from "../src/station/station.mjs";
import { beatKey } from "../src/transcript/index.mjs";

function record(parentId, boundary, order) {
	return {
		beginToolCallId: `b-${order}`,
		endToolCallId: `e-${order}`,
		report: "done",
		parentId,
		order,
		collapsed: false,
		boundary,
		epoch: 4,
		scopeId: `s-${order}`,
		createdAt: 1,
	};
}

describe("fold pool key", () => {
	test("parent and boundary cannot bleed into one another", () => {
		const state = {
			epoch: 4,
			scopes: [{ id: "scope-1" }, { id: "scope-12" }],
			collapses: [
				record("scope-1", 23, 1),
				record("scope-1", 23, 2),
				record("scope-12", 3, 3),
				record("scope-12", 3, 4),
			],
		};
		// The old template key was "scope-1" + "23" + "4" and
		// "scope-12" + "3" + "4": both "scope-1234", one pooled level.
		expect(findActivePools(state)).toHaveLength(2);
	});
});

describe("amend pruning", () => {
	test("keeps live beats and drops keys whose beat left the branch", () => {
		const live = { role: "assistant", content: [], id: "m1", timestamp: 1 };
		const manager = {
			getBranch: () => [],
			buildSessionContext: () => ({ messages: [live] }),
		};
		const station = new SessionStation(manager, {}, {}, null, null);
		station.state.amends = [beatKey(live), "beat-that-left-the-branch"];

		expect(station.pruneAmends()).toBe(1);
		expect(station.state.amends).toEqual([beatKey(live)]);
	});
});
