export const DECISION_FRAMING = "decision-framing";

export const NORMAL_STAGES = Object.freeze([
  "acceptance-cases",
  "architecture-design",
  "orchestration-plan",
  "direct-execution",
]);

export const WORKFLOW_STAGES = Object.freeze([DECISION_FRAMING, ...NORMAL_STAGES]);
