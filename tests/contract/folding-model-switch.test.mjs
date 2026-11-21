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
import {
	MODEL_SWITCH_IMPLEMENTATIONS,
	modelSwitchOff,
	modelSwitchOn,
} from "../../src/features/model-switch/index.mjs";

defineContract("folding", {
	implementations: {
		on: FOLDING_IMPLEMENTATIONS.on(),
		off: FOLDING_IMPLEMENTATIONS.off(),
	},
	cases: {
		"note then kept has the same shape"(impl) {
			const noted = impl.note({ key: "beat-1", text: "one" });
			expect(noted.ok).toBe(true);
			expect(Array.isArray(impl.kept())).toBe(true);
		},
		"fold reports folded and dropped"(impl) {
			impl.note({ key: "beat-1", text: "one" });
			const folded = impl.fold({ retired: () => [] });
			expect(folded.ok).toBe(true);
			expect(typeof folded.folded).toBe("number");
			expect(Array.isArray(folded.dropped)).toBe(true);
		},
	},
});

describe("folding: a retired beat never comes back", () => {
	test("the on implementation drops a key amend retired", () => {
		const folding = foldingOn();
		folding.note({ key: "beat-1", text: "keep" });
		folding.note({ key: "beat-2", text: "drop" });
		const retired = () => ["beat-2"];
		const folded = folding.fold({ retired });
		expect(folded.folded).toBe(1);
		expect(folding.kept()).toEqual([]);
		// The lookup is the amend contract; folding never wrote it.
		expect(retired()).toEqual(["beat-2"]);
	});

	test("the off implementation never revives anything", () => {
		const folding = foldingOff();
		folding.note({ key: "beat-1", text: "keep" });
		expect(folding.fold({ retired: () => [] }).folded).toBe(0);
		expect(folding.kept()).toEqual([]);
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
