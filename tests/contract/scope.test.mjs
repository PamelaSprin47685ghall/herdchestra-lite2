// Scope contract: every implementation answers the same four methods.
//
// `bare` is the shape with no container at all: it refuses everything and
// changes nothing. `single` and `batch` have not landed yet, so the table holds
// null for them and this file marks them as pending instead of skipping them
// silently - an unfinished implementation must be visible.

import { describe, expect, test } from "bun:test";

import { createScopeImplementations } from "../../src/features/scope/index.mjs";
import { defineContract, expectRefusal } from "./_harness.mjs";

const table = createScopeImplementations();
const landed = Object.fromEntries(
	Object.entries(table).filter(([, impl]) => impl !== null),
);
const pending = Object.entries(table)
	.filter(([, impl]) => impl === null)
	.map(([name]) => name);

/** Every scope implementation, whatever its shape, answers these four. */
const METHODS = ["begin", "end", "charge", "snapshot"];

defineContract("scope", {
	implementations: landed,
	cases: {
		"exposes the four port methods"(_impl, ctx) {
			expect(ctx.agent.id).toBe("test-agent");
			for (const method of METHODS) {
				expect(typeof _impl[method]).toBe("function");
			}
		},
	},
});

describe("scope/bare", () => {
	const bare = landed.bare;

	test("every method refuses with the shared code", () => {
		for (const method of METHODS) {
			const result = bare[method]({ intent: "nope" });
			expectRefusal(result, "SCOPE_UNAVAILABLE");
			expect(result.port).toBe("scope");
		}
	});

	test("refusing twice answers the same, and nothing is remembered", () => {
		const first = bare.begin({ intent: "one" });
		const second = bare.begin({ intent: "one" });
		expect(first).toEqual(second);
		expect(bare.snapshot()).toEqual(bare.snapshot());
	});

	test("no state is created by a refused call", () => {
		const before = bare.snapshot();
		bare.begin({ intent: "x" });
		bare.charge("any-id", 5);
		bare.end("any-id");
		expect(bare.snapshot()).toEqual(before);
	});
});

describe("scope table", () => {
	test("the registry names match the three implementations", () => {
		expect(Object.keys(table).sort()).toEqual(["bare", "batch", "single"]);
	});

	test("pending slices are named, not silently missing", () => {
		// This assertion is the reminder: when `single` or `batch` lands, the
		// loop above starts running the contract against it and this list
		// shrinks. An empty list means the port is complete.
		expect(pending).toEqual(["single", "batch"]);
	});
});
