// Test fixture: a world where the three gated stages already ran.
// Integration tests open direct-execution scopes to exercise unrelated
// behavior, so they must start from the state a real workflow reaches.

import { applyStageBegin, createStageFlags } from "../../src/scope/index.mjs";

export const GATED = [
	"acceptance-cases",
	"architecture-design",
	"orchestration-plan",
];

export function allStagesRan() {
	let flags = createStageFlags();
	for (const stage of GATED) flags = applyStageBegin(flags, stage);
	return flags;
}
