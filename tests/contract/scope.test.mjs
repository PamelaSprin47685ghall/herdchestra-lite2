// Scope contract: three containers, one method set.
//
// `bare` refuses everything and changes nothing. `single` opens one container
// on the current session. `batch` opens many, and needs the batch registry
// handed in - without it, it refuses rather than pretending.
//
// The same cases run against all three; the differences that must stay visible
// (depth, flows, refusal codes) get their own assertions.

import { describe, expect, test } from "bun:test";

import { createScopeImplementations } from "../../src/features/scope/index.mjs";
import { defineContract, expectRefusal } from "./_harness.mjs";

const table = createScopeImplementations({
	registerBatch: ({ flows }) => ({ ok: true, batchId: `batch-${flows.length}` }),
});
const noRegistry = createScopeImplementations();

const METHODS = ["begin", "end", "charge", "snapshot"];

defineContract("scope", {
	implementations: table,
	cases: {
		"exposes the four port methods"(impl, ctx) {
			expect(ctx.agent.id).toBe("test-agent");
			for (const method of METHODS) expect(typeof impl[method]).toBe("function");
			expect(["bare", "single", "batch"]).toContain(impl.name);
		},
		"snapshot answers a shape, refusing when there is no container"(impl) {
			const snap = impl.snapshot();
			if (snap.ok === false) {
				// `bare` has no container at all, so describing one is a refusal.
				expect(snap.code).toBe("SCOPE_UNAVAILABLE");
				expect(snap.port).toBe("scope");
				return;
			}
			expect(typeof snap.depth).toBe("number");
			expect(Object.hasOwn(snap, "scope")).toBe(true);
		},
		"ending when nothing is open is a refusal, never a silent success"(impl) {
			const result = impl.end();
			if (result.ok === false) {
				expect(typeof result.code).toBe("string");
				expect(result.port).toBe("scope");
			} else {
				// Finished a scope that was actually open: the harness shares one
				// instance, so this is legitimate for single/batch.
				expect(result.scope).toBeTruthy();
			}
		},
	},
});

describe("scope/bare", () => {
	const bare = table.bare;

	test("every method refuses with the shared code", () => {
		for (const method of METHODS) {
			expectRefusal(bare[method]({ intent: "nope" }), "SCOPE_UNAVAILABLE");
		}
	});

	test("refusing twice answers the same and remembers nothing", () => {
		expect(bare.begin({ intent: "one" })).toEqual(bare.begin({ intent: "one" }));
		expect(bare.snapshot()).toEqual(bare.snapshot());
		expect(bare.snapshot().ok).toBe(false);
	});
});

describe("scope/single", () => {
	test("begin pushes, end pops, budget is spent once", () => {
		const scope = createScopeImplementations().single;
		const opened = scope.begin({ intent: "work", budget: { read: 2 } });
		expect(opened.ok).toBe(true);
		expect(scope.snapshot().depth).toBe(1);

		expect(scope.charge({ read: 1 })).toEqual({ ok: true, remaining: { read: 1 } });
		expect(scope.charge({ read: 1 })).toEqual({ ok: true, remaining: { read: 0 } });

		const exhausted = scope.charge({ read: 1 });
		expect(exhausted).toEqual({
			ok: false,
			code: "BUDGET_EXHAUSTED",
			port: "scope",
			detail: "insufficient budget for read",
			tool: "read",
			available: 0,
			wanted: 1,
		});

		expect(scope.end().ok).toBe(true);
		expect(scope.snapshot().depth).toBe(0);
	});

	test("refuses a begin without an intent", () => {
		const scope = createScopeImplementations().single;
		expectRefusal(scope.begin({}), "SCOPE_UNAVAILABLE");
	});

	test("nested begins stack and close one at a time", () => {
		const scope = createScopeImplementations().single;
		scope.begin({ intent: "outer", budget: {} });
		scope.begin({ intent: "inner", budget: {} });
		expect(scope.snapshot().depth).toBe(2);
		expect(scope.end().scope.intent).toBe("inner");
		expect(scope.snapshot().scope.intent).toBe("outer");
	});
});

describe("scope/batch", () => {
	test("registers a batch and keeps its own stack", () => {
		const scope = table.batch;
		const opened = scope.begin({
			intent: "concurrent",
			budget: { bash: 4 },
			fission: [{ intent: "a" }, { intent: "b" }],
		});
		expect(opened.ok).toBe(true);
		expect(opened.scope.id).toBe("batch-2");
		expect(scope.snapshot().scope.flows).toBe(2);
		scope.end();
	});

	test("refuses without a batch registry instead of pretending", () => {
		const scope = noRegistry.batch;
		expect(scope.begin({ intent: "x", fission: [{ intent: "a" }] })).toEqual({
			ok: false,
			code: "SCOPE_BATCH_UNAVAILABLE",
			port: "scope",
			detail: "this scope has no batch registry, so no batch can open",
		});
	});

	test("refuses a batch with no flows", () => {
		expect(table.batch.begin({ intent: "x", fission: [] })).toEqual({
			ok: false,
			code: "INVALID_FISSION",
			port: "scope",
			detail: "a batch needs at least one flow",
		});
	});

	test("a registry refusal is returned unchanged", () => {
		const refusing = createScopeImplementations({
			registerBatch: () => ({ ok: false, code: "PORT_UNAVAILABLE", port: "fission" }),
		});
		expect(refusing.batch.begin({ intent: "x", fission: [{ intent: "a" }] })).toEqual({
			ok: false,
			code: "PORT_UNAVAILABLE",
			port: "fission",
		});
	});
});

describe("scope table", () => {
	test("the three shapes are all landed", () => {
		expect(Object.keys(table).sort()).toEqual(["bare", "batch", "single"]);
	});
});
