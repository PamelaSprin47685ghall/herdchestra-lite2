import { expect, test } from "bun:test";

import { resolvePorts } from "../src/core/ports/resolve.mjs";
import { injectSystemPrompt } from "../src/host/prompts.mjs";
import { validateFission } from "../src/scope/accounting.mjs";

function state() {
	return {
		relay: { fullFlow: true, firstEvaluation: 1 },
		stageFlags: {},
		herdMode: false,
		scopes: [],
		epoch: 0,
	};
}

const begin = {
	stage: "direct-execution",
	time: 60,
	elder_report: null,
	fission: [{ intent: "one reason", budget: { read: 1 }, permission: "ro" }],
};

test("HERD_DISABLE_STAGES=1 resolves the stages port to off", () => {
	const resolved = resolvePorts({}, { HERD_DISABLE_STAGES: "1" });
	expect(resolved.ok).toBe(true);
	expect(resolved.ports.stages).toBe("off");
});

test("the default keeps the stage-flag gate", () => {
	const result = validateFission(state(), begin, { mainAgent: true, relayOn: false });
	expect(result.ok).toBe(false);
	expect(result.code).toBe("STAGE_FLAGS_UNMET");
});

test("stages off removes that gate for direct-execution", () => {
	const result = validateFission(state(), begin, { mainAgent: true, relayOn: false, stagesOff: true });
	expect(result.ok).toBe(true);
});

test("stages off does not weaken the other refusals", () => {
	const badBudget = {
		...begin,
		fission: [{ intent: "one reason", budget: { read: -1 }, permission: "ro" }],
	};
	const refused = validateFission(state(), badBudget, { mainAgent: true, stagesOff: true });
	expect(refused.ok).toBe(false);
	expect(refused.code).toBe("INVALID_BUDGET");
});

test("stages off omits the stage prompt block from a plain prompt", () => {
	const off = injectSystemPrompt("plain prompt", { stages: "off" });
	expect(off).not.toContain("herdchestra-lite2:stage-prompts");
	expect(off).toContain("plain prompt");
	const on = injectSystemPrompt("plain prompt", { stages: "on" });
	expect(on).toContain("herdchestra-lite2:stage-prompts");
});

test("stages off strips an injected stage block without touching the other rules", () => {
	const on = injectSystemPrompt("plain prompt", { stages: "on" });
	const off = injectSystemPrompt(on, { stages: "off" });
	expect(off).not.toContain("herdchestra-lite2:stage-prompts");
	expect(off).toContain("plain prompt");
	expect(off).toContain("Repo-aware Rules");
});
