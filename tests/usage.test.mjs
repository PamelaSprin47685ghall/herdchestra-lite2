import { describe, expect, test } from "bun:test";
import {
	accumulateUsage,
	boldNumber,
	cacheRate,
	entryUsage,
	hostLabel,
	kFormat,
	pctFormat,
	sessionPrefix,
	totalInput,
	totalUsage,
	usageLine,
	usageSnapshot,
	zeroUsage,
} from "../host-omp/src/host/index.mjs";

describe("usageSnapshot", () => {
	test("accepts every provider alias", () => {
		expect(
			usageSnapshot({
				input_tokens: 1200,
				cache_read_input_tokens: 800,
				cache_creation_input_tokens: 200,
				output_tokens: 300,
				total_cost: 0.25,
			}),
		).toEqual({ input: 1200, cacheRead: 800, cacheWrite: 200, output: 300, cost: 0.25 });
	});

	test("reads nested cost and camelCase fields", () => {
		expect(
			usageSnapshot({
				inputTokens: 10,
				cacheRead: 20,
				cacheWrite: 30,
				outputTokens: 40,
				cost: { total: 0.5 },
			}),
		).toEqual({ input: 10, cacheRead: 20, cacheWrite: 30, output: 40, cost: 0.5 });
	});

	test("treats junk as zero", () => {
		expect(usageSnapshot({ input_tokens: "oops", output_tokens: null })).toEqual(zeroUsage());
	});

	test("sums billing components when the provider omits a total", () => {
		expect(
			usageSnapshot({
				input_tokens: 1000,
				output_tokens: 200,
				cost: { input: 0.003, output: 0.0006, cacheRead: 0.00004, cacheWrite: 0 },
			}).cost,
		).toBeCloseTo(0.00364, 9);
	});

	test("keeps the provider total when it is present", () => {
		expect(
			usageSnapshot({ cost: { input: 1, output: 2, total: 2.5 } }).cost,
		).toBe(2.5);
	});
});

describe("formatting", () => {
	test("computes total input and cache rate", () => {
		const snapshot = { input: 1000, cacheRead: 500, cacheWrite: 0, output: 200, cost: 0 };
		expect(totalInput(snapshot)).toBe(1500);
		expect(cacheRate(snapshot)).toBeCloseTo(33.333, 3);
		expect(cacheRate(zeroUsage())).toBe(0);
	});

	test("formats numbers exactly like Lite", () => {
		expect(kFormat(1500)).toBe("1.5k");
		expect(pctFormat(33.333)).toBe("33.3%");
		expect(boldNumber("0.123")).toBe("𝟬.𝟭𝟮𝟯");
	});

	test("renders the exact working line", () => {
		const current = { input: 1000, cacheRead: 500, cacheWrite: 0, output: 200, cost: 0.123 };
		const total = { input: 2000, cacheRead: 1000, cacheWrite: 0, output: 400, cost: 0.25 };
		expect(usageLine(current, total)).toBe(
			"Δ: 1.5k × 33.3% → 0.2k [¥𝟬.𝟭𝟮𝟯]; Σ: 3.0k × 33.3% → 0.4k [¥𝟬.𝟮𝟱𝟬];",
		);
	});
});

describe("aggregation", () => {
	test("accumulates snapshots in place", () => {
		const total = zeroUsage();
		accumulateUsage(total, { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, cost: 0.5 });
		accumulateUsage(total, { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, cost: 1.5 });
		expect(total).toEqual({ input: 11, cacheRead: 22, cacheWrite: 33, output: 44, cost: 2 });
	});

	test("adds each call's charge whatever the model rate was", () => {
		const total = zeroUsage();
		// Equal token counts on two models cost different amounts. The total
		// must be the sum of the charges, not the tokens times one rate.
		accumulateUsage(total, { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0.03 });
		accumulateUsage(total, { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0.002 });
		expect(total.cost).toBeCloseTo(0.032, 12);
	});

	test("sums a list without mutating the inputs", () => {
		const first = { input: 1, cacheRead: 0, cacheWrite: 0, output: 2, cost: 0.1 };
		const second = { input: 3, cacheRead: 0, cacheWrite: 0, output: 4, cost: 0.2 };
		expect(totalUsage([first, second])).toEqual({
			input: 4,
			cacheRead: 0,
			cacheWrite: 0,
			output: 6,
			cost: 0.30000000000000004,
		});
	});

	test("reads branch entries", () => {
		expect(
			entryUsage({ type: "message", message: { role: "assistant", usage: { input: 5 } } }),
		).toEqual({ input: 5 });
		expect(entryUsage({ type: "message", message: { role: "user" } })).toBeUndefined();
		expect(entryUsage({ type: "model_usage", usage: { output: 7 } })).toEqual({ output: 7 });
		expect(entryUsage({ type: "custom" })).toBeUndefined();
	});
});

describe("session and host labels", () => {
	test("extracts a session prefix", () => {
		expect(sessionPrefix("Herd 2A: mission")).toBe("Herd 2A");
		expect(sessionPrefix("plain name")).toBe("plain name");
		expect(sessionPrefix(undefined)).toBeNull();
	});

	test("builds a short host label", () => {
		expect(hostLabel("kun", "box.example.com")).toBe("kun@box");
		expect(hostLabel("", "box")).toBeNull();
		expect(hostLabel("kun", "")).toBeNull();
	});
});
