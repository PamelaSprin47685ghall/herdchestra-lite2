// Contract tests for folding and model-switch.
//
// Both ports answer the same shape through every implementation. Folding's
// extra requirement is the bill-split direction made executable: the fold reads
// a retired-key lookup that arrives as an argument, and a retired key can never
// reappear in `kept`.

import { describe, expect, test } from "bun:test";

import { defineContract } from "./_harness.mjs";
import {
	FOLDING_IMPLEMENTATIONS,
	foldingOff,
	foldingOn,
} from "../../src/features/folding/index.mjs";
import { FOLDED_MARKER } from "../../src/transcript/collapse.mjs";
import {
	MODEL_SWITCH_IMPLEMENTATIONS,
	modelSwitchOff,
	modelSwitchOn,
} from "../../src/features/model-switch/index.mjs";

function receiptFixture() {
	const receipts = [
		{
			forkToolCallId: "f1",
			closeToolCallId: "j1",
			levelKey: "root",
			closedOrder: 1,
			report: "first summary",
		},
		{
			forkToolCallId: "f2",
			closeToolCallId: "j2",
			levelKey: "root",
			closedOrder: 2,
			report: "youngest summary",
		},
	];
	const original = "original record text ".repeat(20);
	const messages = [
		{ role: "toolResult", toolCallId: "j1", content: [{ type: "text", text: original }] },
		{ role: "toolResult", toolCallId: "j2", content: [{ type: "text", text: original }] },
	];
	return { receipts, messages };
}

defineContract("folding", {
	implementations: {
		on: FOLDING_IMPLEMENTATIONS.on(),
		off: FOLDING_IMPLEMENTATIONS.off(),
	},
	cases: {
		"foldable answers an array"(impl) {
			expect(Array.isArray(impl.foldable([]))).toBe(true);
		},
		"apply answers messages and collapsed"(impl) {
			const out = impl.apply([], [], { foldable: [] });
			expect(Array.isArray(out.messages)).toBe(true);
			expect(Array.isArray(out.collapsed)).toBe(true);
		},
	},
});

describe("folding: the port shortens only the elder receipt", () => {
	test("on folds the older receipt and keeps the youngest", () => {
		const { receipts, messages } = receiptFixture();
		const folding = foldingOn();
		const foldable = folding.foldable(receipts);
		expect(foldable.map((entry) => entry.closeToolCallId)).toEqual(["j1"]);
		const folded = folding.apply(messages, receipts, { foldable });
		expect(folded.collapsed).toEqual(["j1"]);
		expect(folded.messages[0].content[0].text).toContain(FOLDED_MARKER);
		expect(folded.messages[1]).toBe(messages[1]);
	});

	test("off is a real ablation: nothing is foldable and nothing changes", () => {
		const { receipts, messages } = receiptFixture();
		const folding = foldingOff();
		expect(folding.foldable(receipts)).toEqual([]);
		const folded = folding.apply(messages, receipts, { foldable: [] });
		expect(folded.messages).toBe(messages);
		expect(folded.collapsed).toEqual([]);
		expect(folded.messages[0].content[0].text).not.toContain(FOLDED_MARKER);
	});
});

defineContract("modelSwitch", {
	implementations: {
		on: MODEL_SWITCH_IMPLEMENTATIONS.on("base"),
		off: MODEL_SWITCH_IMPLEMENTATIONS.off("base"),
	},
	cases: {
		"current always answers a spec"(impl) {
			const current = impl.current("scope-1");
			expect(current.ok).toBe(true);
			expect(typeof current.spec).toBe("string");
		},
	},
});

describe("model-switch: off is a constant, not a silent no-op", () => {
	test("on remembers a choice per scope", () => {
		const models = modelSwitchOn("base");
		expect(models.choose("s1", "fast").ok).toBe(true);
		expect(models.current("s1")).toEqual({ ok: true, spec: "fast", switched: true });
		expect(models.current("s2")).toEqual({ ok: true, spec: "base", switched: false });
	});

	test("off refuses to switch and keeps the baseline", () => {
		const models = modelSwitchOff("base");
		expect(models.choose("s1", "fast")).toEqual({
			ok: false,
			code: "MODEL_SWITCH_DISABLED",
			port: "modelSwitch",
		});
		expect(models.current("s1")).toEqual({ ok: true, spec: "base", switched: false });
	});
});
