/**
 * Contract tests for the stage, herd mode, and pinned-context surfaces.
 * They pin the model-facing text: a receipt names its stage and never copies
 * the stage prompt body, pinned records reach the successor, and the stage
 * block stays a stable four-section prefix.
 */

import { describe, expect, test } from "bun:test";
import { beginScope, createState } from "../src/scope/index.mjs";
import { handoffFocus, successorOpeningText } from "../src/relay/texts.mjs";
import { stagePromptsBlock } from "../src/host/prompts.mjs";
import {
  beginText,
  herdModeSteer,
  skillReceiptText,
} from "../src/station/texts.mjs";

function open(stage, intent = "work") {
  const state = createState();
  const result = beginScope(state, {
    toolCallId: "call_begin",
    intent,
    stage,
    budget: { read: 1 },
  });
  expect(result.ok).toBe(true);
  return { state, scope: result.scope };
}

const PROMPT_BODIES = [
  "Ronald A. Howard",
  "James Bach",
  "George Polya",
  "Donald E. Knuth",
];

describe("stage receipts", () => {
  for (const stage of [
    "decision-framing",
    "acceptance-cases",
    "architecture-design",
    "orchestration-plan",
  ]) {
    test(`names ${stage} without copying its prompt body`, () => {
      const { scope } = open(stage);
      const text = beginText(scope);
      expect(text).toContain(`Stage: ${stage}.`);
      for (const body of PROMPT_BODIES) expect(text).not.toContain(body);
    });
  }

  test("says direct-execution has no stage prompt", () => {
    const { scope } = open("direct-execution");
    const text = beginText(scope);
    expect(text).toContain("Stage: direct-execution.");
    expect(text).toContain("no stage prompt");
  });
});

describe("stage prompt block", () => {
  test("holds exactly the four sections and no direct-execution section", () => {
    expect(stagePromptsBlock).toContain("[Stage: decision-framing]");
    expect(stagePromptsBlock).toContain("[Stage: acceptance-cases]");
    expect(stagePromptsBlock).toContain("[Stage: architecture-design]");
    expect(stagePromptsBlock).toContain("[Stage: orchestration-plan]");
    expect(stagePromptsBlock).not.toContain("[Stage: direct-execution]");
    expect(stagePromptsBlock).toContain(
      "Exactly one stage section governs at a time",
    );
  });
});

describe("herd mode text", () => {
  test("the receipt reports herd mode and the innermost stage", () => {
    const { state, scope } = open("decision-framing");
    state.herdMode = true;
    const receipt = skillReceiptText(state, false);
    expect(receipt).toContain("Herd mode: on.");
    expect(receipt).toContain(`Stage: ${scope.stage}.`);
  });

  test("the receipt reports herd mode off outside a scope", () => {
    const receipt = skillReceiptText(createState(), false);
    expect(receipt).toContain("Herd mode: off.");
    expect(receipt).not.toContain("Stage:");
  });

  test("the toggle steer names the stage policy of each mode", () => {
    expect(herdModeSteer(true)).toContain("decision-framing");
    expect(herdModeSteer(true)).toContain("ask");
    const off = herdModeSteer(false);
    expect(off).toContain("acceptance-cases");
    expect(off).toContain("architecture-design");
    expect(off).toContain("orchestration-plan");
    expect(off).toContain("direct-execution");
  });
});

describe("pinned context across a handoff", () => {
  const pins = [
    "**Finding:** the case set lives at docs/cases.md",
    "**Conclusion:** ship the flat design",
  ];

  test("the opening text carries every pin and the full-read rule", () => {
    const text = successorOpeningText(createState().relay, "report", pins);
    expect(text).toContain("## Pinned Context");
    for (const pin of pins) expect(text).toContain(pin);
    expect(text).toContain(
      "Before starting work, use read to read each important document on disk listed in Pinned Context in full.",
    );
  });

  test("an empty pin list still names the section", () => {
    const text = successorOpeningText(createState().relay, "report", []);
    expect(text).toContain("## Pinned Context");
    expect(text).toContain("No pinned records.");
  });

  test("the handoff focus requires the same full read", () => {
    expect(handoffFocus(createState().relay)).toContain(
      "Before starting work, use read to read each important document on disk listed in Pinned Context in full.",
    );
  });
});
