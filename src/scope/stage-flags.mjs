// Boolean stage flags: a stage counts as run once its scope opens.
//
// S2/S3/S4 start false and turn true when their scope opens. S5 requires all
// three true and never clears them. Opening S1 clears all three, because a new
// decision starts a new line of work. Pure data; no I/O.

import { DECISION_FRAMING } from "./stages.mjs";

export const GATED_STAGES = Object.freeze([
	"acceptance-cases",
	"architecture-design",
	"orchestration-plan",
]);

export const EXECUTION_STAGE = "direct-execution";

export function createStageFlags() {
	return {
		"acceptance-cases": false,
		"architecture-design": false,
		"orchestration-plan": false,
	};
}

/** Copy only the three gated keys; anything else becomes false. */
export function copyStageFlags(source) {
	const out = createStageFlags();
	if (!source || typeof source !== "object") return out;
	for (const stage of GATED_STAGES) out[stage] = source[stage] === true;
	return out;
}

/** Stages that have not run yet, in workflow order. */
export function missingStages(flags) {
	const safe = copyStageFlags(flags);
	return GATED_STAGES.filter((stage) => safe[stage] !== true);
}

/**
 * Apply the rule for one opening scope:
 * S1 resets everything, S2/S3/S4 set their own flag, S5 changes nothing.
 */
export function applyStageBegin(flags, stage) {
	const next = copyStageFlags(flags);
	if (stage === DECISION_FRAMING) {
		for (const gated of GATED_STAGES) next[gated] = false;
	} else if (GATED_STAGES.includes(stage)) {
		next[stage] = true;
	}
	return next;
}
