// Station control handlers: amend and pin arguments.
// `handleAmendCall` and `handlePinCall` are legacy transcript-scan paths.
// The tool catalog does not register them; live pinning goes through
// `scope_context`. Plain synchronous functions. The station owns the state;
// this module owns the argument validation and the resulting text.

import { applyAmend } from "../scope/index.mjs";
import { PIN_INTERNAL_ERROR, PIN_UNAVAILABLE } from "../features/pin/index.mjs";
import { errorResult, textResult } from "../tools/results.mjs";
import { parseArgs, trimText } from "./messages.mjs";
import { amendText, PIN_SAVED_TEXT } from "./texts.mjs";

import { loadDoc } from "../prompts/index.mjs";

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
  return textResult(amendText(applied, boundary.record, station.clockPort?.() ?? null), {
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
  if (lines.length === 0) {
    // A call that names no field, or only spaces, would otherwise report OK
    // while the notebook stayed empty.
    return errorResult("INVALID_ARGUMENT", E["pin-empty"], {
      fields: ["assumption", "deduction", "induction", "finding", "conclusion"],
    });
  }
  const note = lines.join("\n\n");
  const saved = station.pinPort().add(note);
  if (!saved.ok) return errorResult(saved.code, E["pin-unavailable"]);
  // The in-memory note must not survive a failed write: the caller would
  // believe the pin was kept and a reload would lose it.
  const rollback = () => {
    const notes = station.state?.pins;
    if (Array.isArray(notes) && notes[notes.length - 1] === note) notes.pop();
  };
  let persisted;
  try {
    persisted = station.persist();
  } catch (error) {
    rollback();
    station.noteError?.("persist", error, { tool: "pin" });
    return errorResult(PIN_INTERNAL_ERROR, E["pin-internal"]);
  }
  if (persisted === false) {
    rollback();
    return errorResult(PIN_UNAVAILABLE, E["pin-unavailable"]);
  }
  return textResult(PIN_SAVED_TEXT);
}

export { handleAmendCall, handlePinCall };
