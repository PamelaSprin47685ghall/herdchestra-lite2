import { describe, expect, test } from "bun:test";

import {
	applyStageBegin,
	copyStageFlags,
	createStageFlags,
	createState,
	deserializeState,
	missingStages,
	serializeState,
	truncateForHostBoundary,
} from "../src/scope/index.mjs";
import { loadDoc, render } from "../src/prompts/index.mjs";

describe("stage flags", () => {
	test("start with every gated stage false", () => {
		expect(createStageFlags()).toEqual({
			"acceptance-cases": false,
			"architecture-design": false,
			"orchestration-plan": false,
		});
		expect(missingStages(createStageFlags())).toEqual([
			"acceptance-cases",
			"architecture-design",
			"orchestration-plan",
		]);
	});

	test("running one gated stage sets only its own flag", () => {
		const flags = applyStageBegin(createStageFlags(), "acceptance-cases");
		expect(flags["acceptance-cases"]).toBe(true);
		expect(flags["architecture-design"]).toBe(false);
		expect(flags["orchestration-plan"]).toBe(false);
		expect(missingStages(flags)).toEqual([
			"architecture-design",
			"orchestration-plan",
		]);
	});

	test("all three accumulate and execution stays allowed", () => {
		let flags = createStageFlags();
		for (const stage of [
			"acceptance-cases",
			"architecture-design",
			"orchestration-plan",
		]) {
			flags = applyStageBegin(flags, stage);
		}
		expect(missingStages(flags)).toEqual([]);
		// S5 does not clear anything, so it may run repeatedly.
		const again = applyStageBegin(flags, "direct-execution");
		expect(again).toEqual(flags);
	});

	test("opening decision-framing resets all three", () => {
		let flags = applyStageBegin(createStageFlags(), "acceptance-cases");
		flags = applyStageBegin(flags, "architecture-design");
		flags = applyStageBegin(flags, "orchestration-plan");
		expect(missingStages(flags)).toEqual([]);
		flags = applyStageBegin(flags, "decision-framing");
		expect(flags).toEqual(createStageFlags());
	});

	test("copies tolerate missing and non-boolean values", () => {
		expect(copyStageFlags(undefined)).toEqual(createStageFlags());
		expect(copyStageFlags({ "acceptance-cases": "yes" })).toEqual(
			createStageFlags(),
		);
		expect(copyStageFlags({ "acceptance-cases": true })).toEqual({
			"acceptance-cases": true,
			"architecture-design": false,
			"orchestration-plan": false,
		});
	});

	test("the rejection text names the missing stages", () => {
		const doc = loadDoc("errors");
		const message = render(doc["stage-flags-unmet"], {
			missing: "architecture-design, orchestration-plan",
		});
		expect(message).toContain("architecture-design, orchestration-plan");
	});
});

describe("stage flag persistence", () => {
	test("round-trips through serialize and deserialize", () => {
		const state = createState();
		state.stageFlags = applyStageBegin(state.stageFlags, "acceptance-cases");
		const restored = deserializeState(
			JSON.parse(JSON.stringify(serializeState(state))),
		);
		expect(restored.stageFlags).toEqual(state.stageFlags);
	});

	test("old snapshots without the field default to all false", () => {
		const payload = serializeState(createState());
		delete payload.stageFlags;
		expect(deserializeState(payload).stageFlags).toEqual(createStageFlags());
	});

	test("corrupt flags degrade to all false instead of discarding state", () => {
		const payload = serializeState(createState());
		payload.stageFlags = { "acceptance-cases": 1 };
		expect(deserializeState(payload).stageFlags).toEqual(createStageFlags());
	});

	test("the host boundary keeps the flags", () => {
		const state = createState();
		state.stageFlags = applyStageBegin(state.stageFlags, "acceptance-cases");
		truncateForHostBoundary(state);
		expect(state.stageFlags["acceptance-cases"]).toBe(true);
	});
});
