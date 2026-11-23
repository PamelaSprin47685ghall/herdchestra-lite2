import { describe, expect, it } from "bun:test";
import {
	deriveTimeBudgetSeconds,
	modelSamples,
	recordTurnSample,
} from "../src/scope/turn-stats.mjs";

function session() {
	return {};
}

function budgetOf(sessionLedger, modelKey) {
	return deriveTimeBudgetSeconds({
		samples: modelSamples(sessionLedger, modelKey),
		budget: { read: 1 },
	});
}

describe("budget samples are scoped to one session and one model", () => {
	it("never mixes another model's speed", () => {
		const totals = session();
		recordTurnSample(totals, "model-a", 2_000);
		expect(budgetOf(totals, "model-a")).toBe(2);
		expect(budgetOf(totals, "model-b")).toBe(60);
	});

	it("never uses another session's samples", () => {
		const oldSession = session();
		recordTurnSample(oldSession, "m", 4_000);
		const newSession = session();
		expect(budgetOf(newSession, "m")).toBe(60);
	});

	it("merges samples from every scope in the same session and model", () => {
		const totals = session();
		recordTurnSample(totals, "m", 2_000);
		recordTurnSample(totals, "m", 6_000);
		expect(budgetOf(totals, "m")).toBe(4);
	});

	it("a restored ledger starts with no samples", () => {
		const before = session();
		recordTurnSample(before, "m", 5_000);
		const afterRestore = session();
		expect(modelSamples(afterRestore, "m")).toEqual([]);
		expect(budgetOf(afterRestore, "m")).toBe(60);
	});

	it("falls back instead of using samples with no model identity", () => {
		const totals = session();
		expect(recordTurnSample(totals, "", 9_000)).toBe(false);
		expect(budgetOf(totals, "m")).toBe(60);
	});

	it("switching the station model never borrows the previous model's samples", () => {
		const ledger = session();
		const station = { state: { baseModelKey: "model-a" }, turnModelKey: "model-a" };
		const timeOf = () =>
			deriveTimeBudgetSeconds({
				samples: modelSamples(
					ledger,
					station.state.baseModelKey ?? station.turnModelKey,
				),
				budget: { read: 1 },
			});
		recordTurnSample(ledger, "model-a", 2_000);
		expect(timeOf()).toBe(2);
		station.state.baseModelKey = "model-b";
		expect(timeOf()).toBe(60);
		recordTurnSample(ledger, "model-b", 8_000);
		expect(timeOf()).toBe(8);
	});
});
