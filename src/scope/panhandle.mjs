// Scope panhandle: what a branch does when its turns are already spent.
//
// There is no rescue tool and there is no grant for it. A call whose turns are
// gone still runs, and the record keeps the tool's name in `panhandles`, so the
// overrun is read back where it happened: `forkTurnsText` ends the branch's
// turns line with `panhandled Nx`, and the caller reads that line when the
// branch returns. The cost of panhandling is not a refusal. It is that the
// overrun is public, and it stays on the record after the work is done.
//
// Adding turns is a different act, and it is not a rescue: `amendFork`
// calls `grantTurns` when a reused scope arrives with more work. Scope size
// follows the work a scope holds, so the grant adds and never caps.

import {
  copyCounts,
  failure,
  isNonEmptyString,
  isPlainObject,
  put,
} from "./state.mjs";
import { isFreeTool, normalizeToolName } from "./turns.mjs";

/**
 * Record one call that ran past its turns. The panhandle count records
 * admissions: one entry per distinct call, never one per retry, so a reloaded
 * branch shows the same number its caller will read.
 */
export function notePanhandled(record, tool, options = {}) {
  if (!record || typeof record !== "object") {
    return failure("UNKNOWN_FORK", "No branch record to mark.");
  }
  if (!isNonEmptyString(tool)) {
    return failure("INVALID_TOOL", "A panhandled call must name its tool.");
  }
  if (!Array.isArray(record.panhandles)) record.panhandles = [];
  const at = Number.isFinite(options.now) ? options.now : Date.now();
  const callId = typeof options.callId === "string" && options.callId !== "" ? options.callId : null;
  // One entry per call: a call that both ran past its turns and ended past
  // the deadline is one debt, not two.
  if (callId !== null) {
    const seen = record.panhandles.find((entry) => entry?.callId === callId);
    if (seen) return { ok: true, count: record.panhandles.length, tool };
  }
  record.panhandles.push(callId === null ? { at, tool } : { at, tool, callId });
  return { ok: true, count: record.panhandles.length, tool };
}

/** Read-only view of the panhandle count, for a receipt or a summary line. */
export function panhandleCount(record) {
  const entries = Array.isArray(record?.panhandles) ? record.panhandles : [];
  const tools = [];
  for (const entry of entries) {
    const tool = typeof entry?.tool === "string" ? entry.tool : "";
    if (tool !== "" && !tools.includes(tool)) tools.push(tool);
  }
  return { count: entries.length, tools };
}

/**
 * Read and validate the requested tool turns. Keys merge after name
 * normalization, so `apply_patch` and `edit` share one entry.
 */
function readTools(value) {
  if (value === undefined) return { ok: true, tools: {} };
  if (!isPlainObject(value)) {
    return failure(
      "GRANT_INVALID_TOOLS",
      "Tools must be a plain object of whole turns.",
    );
  }
  const tools = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !isNonEmptyString(key)) {
      return failure("GRANT_INVALID_TOOLS", "Each tool key must name a tool.");
    }
    const amount = value[key];
    if (!Number.isInteger(amount) || amount <= 0) {
      return failure(
        "GRANT_INVALID_TOOLS",
        `"${key}" must be a whole number of turns, at least 1.`,
      );
    }
    const tool = normalizeToolName(key);
    if (isFreeTool(tool)) {
      return failure(
        "GRANT_FREE_TOOL",
        `"${tool}" is free at every level and cannot be granted.`,
      );
    }
    put(tools, tool, (Object.hasOwn(tools, tool) ? tools[tool] : 0) + amount);
  }
  return { ok: true, tools };
}

function readSeconds(value) {
  if (value === undefined) return { ok: true, seconds: 0 };
  if (!Number.isInteger(value) || value <= 0) {
    return failure(
      "GRANT_INVALID_SECONDS",
      "seconds must be a whole number of seconds, at least 1.",
    );
  }
  return { ok: true, seconds: value };
}

/**
 * Validate and add tool turns and seconds to one record's account. The caller
 * owns the status gate; validation runs before any mutation. There is no
 * ceiling on the result: a scope that holds more work holds more turns.
 */
export function grantTurns(record, request = {}, options = {}) {
  if (!record || typeof record !== "object") {
    return failure("UNKNOWN_FORK", "No branch record to grant.");
  }
  const source = isPlainObject(request) ? request : {};
  const wanted = readTools(source.tools);
  if (!wanted.ok) return wanted;
  const timed = readSeconds(source.seconds);
  if (!timed.ok) return timed;
  const tools = wanted.tools;
  const seconds = timed.seconds;
  if (Object.keys(tools).length === 0 && seconds === 0) {
    return failure(
      "GRANT_EMPTY",
      "Name at least one tool's turns, or ask for seconds.",
    );
  }
  if (
    seconds > 0 &&
    !Number.isFinite(record.deadlineAt) &&
    record.status !== "blocked" &&
    options?.allowClockOff !== true
  ) {
    return failure(
      "GRANT_CLOCK_OFF",
      "This branch has no wall clock to extend; ask for tool turns instead.",
    );
  }

  if (!isPlainObject(record.budget)) record.budget = {};
  if (!isPlainObject(record.remaining)) record.remaining = copyCounts(record.budget);
  for (const tool of Object.keys(tools)) {
    const added = tools[tool];
    put(
      record.budget,
      tool,
      (Object.hasOwn(record.budget, tool) ? record.budget[tool] : 0) + added,
    );
    put(
      record.remaining,
      tool,
      (Object.hasOwn(record.remaining, tool) ? record.remaining[tool] : 0) + added,
    );
  }
  if (seconds > 0) {
    record.timeBudgetMs =
      (Number.isFinite(record.timeBudgetMs) ? record.timeBudgetMs : 0) +
      seconds * 1000;
    if (Number.isFinite(record.deadlineAt)) {
      record.deadlineAt += seconds * 1000;
    }
    // A grant that moves the deadline back into the future ends overtime.
    record.overtimeAt = null;
  }
  return { ok: true, tools: { ...tools }, seconds, record };
}
