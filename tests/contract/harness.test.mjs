// The harness must be trusted before any port relies on it: it has to run
// every case against every implementation, and a failure has to name both.

import { describe, expect, test } from "bun:test";

import { defineContract, expectRefusal, fakeCtx, runCase } from "./_harness.mjs";

function counterPort() {
	const make = () => ({ count: 0, bump() { return (this.count += 1); } });
	return { first: make(), second: make() };
}

describe("contract harness", () => {
	test("runCase passes the context through to the case", async () => {
		const seen = [];
		await runCase("probe", "alpha", "records", (ctx) => {
			seen.push(ctx.agent.id);
		});
		expect(seen).toEqual(["test-agent"]);
	});

	test("a failure names the port, the implementation and the case", async () => {
		let caught = null;
		try {
			await runCase("probe", "beta", "breaks", () => {
				throw new Error("deliberate");
			});
		} catch (error) {
			caught = error;
		}
		expect(caught.message).toBe("[probe/beta] breaks: deliberate");
	});

	test("refusals are data with a code and a port", () => {
		const result = expectRefusal(
			{ ok: false, code: "PORT_UNAVAILABLE", port: "scope", detail: "nope" },
			"PORT_UNAVAILABLE",
		);
		expect(result.port).toBe("scope");
		expect(() => expectRefusal({ ok: true }, "PORT_UNAVAILABLE")).toThrow(/expected a refusal/);
		expect(() =>
			expectRefusal({ ok: false, code: "OTHER", port: "scope" }, "PORT_UNAVAILABLE"),
		).toThrow(/expected refusal code/);
	});

	test("the fake context carries an agent and a clock", () => {
		const ctx = fakeCtx();
		expect(ctx.agent.id).toBe("test-agent");
		expect(ctx.now()).toBe(1_000);
		expect(fakeCtx({ now: () => 5 }).now()).toBe(5);
	});

	test("an empty port is refused at definition time", () => {
		expect(() => defineContract("empty", { implementations: {}, cases: { a() {} } })).toThrow(
			/has no implementations/,
		);
		expect(() => defineContract("empty", { implementations: { only: {} }, cases: {} })).toThrow(
			/has no contract cases/,
		);
	});
});
