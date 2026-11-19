// Stage prompt text for the workflow stages, from resources/prompts/stages.md.
// `direct-execution` has no section by design.

import { loadDoc } from "../prompts/index.mjs";

const stages = loadDoc("stages");

export const decisionFramingPrompt = stages["decision-framing"];
export const acceptanceCasesPrompt = stages["acceptance-cases"];
export const architectureDesignPrompt = stages["architecture-design"];
export const orchestrationPlanPrompt = stages["orchestration-plan"];
