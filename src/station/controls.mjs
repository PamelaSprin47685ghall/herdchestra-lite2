// Station control handlers: amend and pin arguments.
// Plain synchronous functions. The station owns the state; this module owns
// the argument validation and the resulting text.

import { applyAmend } from "../scope/index.mjs";
import { filterAmends } from "../transcript/index.mjs";
import { invalidatePromotion } from "../relay/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { parseArgs, trimText } from "./messages.mjs";
import { amendText } from "./texts.mjs";

import { loadDoc, render } from "../prompts/index.mjs";

const E = loadDoc("errors");

function handleAmendCall(station, call, base, currentIndex, boundary) {
  const state = station.state;
  const args = parseArgs(call);
  const reflection = trimText(args.reflection);
  if (!reflection) {
    return errorResult("INVALID_ARGUMENT", E["amend-reflection"], {
      field: "reflection",
    });
  }
  const target = station.findAmendTarget(base, currentIndex, boundary);
  if (!target.ok) return errorResult(target.code, target.reason);
  const recorded = station.amendPort().record(target.beat.key);
  if (!recorded.ok) return errorResult(recorded.code, E["amend-unavailable"]);
  const applied = applyAmend(state, boundary.ledger, {
    ownerId: boundary.ownerId,
    beat: target.beat,
    toolCalls: target.toolCalls,
  });
  if (!applied.ok) return errorResult(applied.code, applied.reason);
  return textResult(amendText(applied, boundary.record), {
    refunded: applied.refunded,
  });
}

function handlePinCall(station, call) {
  const args = parseArgs(call);
  const lines = [];
  for (const label of ["Assumption", "Deduction", "Induction", "Finding", "Conclusion"]) {
    const text = trimText(args[label.toLowerCase()]);
    if (text) lines.push(`**${label}:** ${text}`);
  }
  if (lines.length === 0) return textResult("OK");
  const saved = station.pinPort().add(lines.join("\n\n"));
  if (!saved.ok) return errorResult(saved.code, E["pin-unavailable"]);
  station.persist();
  return textResult("OK");
}

export { handleAmendCall, handlePinCall };
