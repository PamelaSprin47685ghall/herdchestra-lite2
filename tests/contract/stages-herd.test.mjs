import { describe, expect, test } from "bun:test";

import { defineContract } from "./_harness.mjs";
import { HERD_IMPLEMENTATIONS } from "../../src/features/herd/index.mjs";
import { STAGES_IMPLEMENTATIONS } from "../../src/features/stages/index.mjs";

describe("herd port", () => {
	for (const [name, create] of Object.entries(HERD_IMPLEMENTATIONS)) {
		test(`${name}: mode() is a string and toggle answers in the shared shape`, () => {
			const herd = create();
			expect(typeof herd.mode()).toBe("string");
			const result = herd.toggle("hello");
			expect(typeof result.ok).toBe("boolean");
			if (result.ok === false) {
				expect(result.port).toBe("herd");
				expect(typeof result.code).toBe("string");
			}
		});
	}

	test("on flips the mode and off refuses forever", () => {
		const on = HERD_IMPLEMENTATIONS.on();
		expect(on.mode()).toBe("off");
		expect(on.toggle().mode).toBe("on");
		expect(on.mode()).toBe("on");

		const off = HERD_IMPLEMENTATIONS.off();
		expect(off.mode()).toBe("off");
		expect(off.toggle()).toEqual({ ok: false, code: "HERD_UNAVAILABLE", port: "herd" });
		expect(off.mode()).toBe("off");
	});
});

describe("stages port", () => {
	test("on admits decision-framing only while herd reports on", () => {
		let mode = "off";
		const stages = STAGES_IMPLEMENTATIONS.on({ mode: () => mode });
		expect(stages.allows("decision-framing")).toBe(false);
		mode = "on";
		expect(stages.allows("decision-framing")).toBe(true);
		expect(stages.allows("acceptance-cases")).toBe(true);
	});

	test("on refuses to open a stage it does not allow", () => {
		const stages = STAGES_IMPLEMENTATIONS.on({ mode: () => "off" });
		expect(stages.open("s1", "decision-framing")).toEqual({
			ok: false,
			code: "INVALID_STAGE",
			port: "stages",
			stage: "decision-framing",
		});
		expect(stages.snapshot().opened).toEqual([]);
	});

	test("off allows nothing and opens nothing", () => {
		const stages = STAGES_IMPLEMENTATIONS.off();
		expect(stages.allows("acceptance-cases")).toBe(false);
		expect(stages.open("s1", "acceptance-cases")).toEqual({ ok: true, skipped: true });
		expect(stages.snapshot()).toEqual({ opened: [], flags: {} });
	});

	test("stages never writes the herd fact it reads", () => {
		let reads = 0;
		const published = { mode: "on" };
		const stages = STAGES_IMPLEMENTATIONS.on({
			mode: () => {
				reads += 1;
				return published.mode;
			},
		});
		const before = structuredClone(published);
		stages.allows("decision-framing");
		stages.open("s1", "decision-framing");
		expect(reads).toBeGreaterThan(0);
		expect(published).toEqual(before);
	});
});

// The contract suite registers its own bun tests, so it must sit at file scope.
defineContract("stages", {
	implementations: { on: STAGES_IMPLEMENTATIONS.on(), off: STAGES_IMPLEMENTATIONS.off() },
	cases: {
		"snapshot returns an object with opened and flags"(impl) {
			const snap = impl.snapshot();
			expect(Array.isArray(snap.opened)).toBe(true);
			expect(typeof snap.flags).toBe("object");
		},
	},
});
