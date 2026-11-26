// Scope panhandle: what a branch does when its turns are already spent.
//
// There is no rescue tool and there is no grant for it. A call whose turns are
// gone still runs, and the record keeps the tool's name in `panhandles`, so the
// overrun is read back where it happened: the REPL probe's `remaining` object
// carries `panhandled N`, and the caller reads it when the branch returns. The
// cost of panhandling is not a refusal. It is that the overrun is public, and
// it stays on the record after the work is done.
//
// Adding turns is a different act, and it is not a rescue: `grantBudget` adds
// when a scope is reused with more work. Scope size follows the work a scope
// holds, so the grant adds and never caps.

import {
  copyCounts,
  failure,
  isNonEmptyString,
  put,
} from "./state.mjs";
import { isPlainObject } from "./plain.mjs";
import { isFreeTool, normalizeToolName } from "./turns.mjs";
import { editRecord } from "./record-mutation.mjs";

/**
 * How many recent admissions one record keeps in full.
 *
 * The count and the tool list are cumulative; only the entries are bounded.
 * A long branch can panhandle hundreds of calls, and each entry used to stay
 * on the record (and in every snapshot) for the life of the session.
 */
export const MAX_PANHANDLES = 16;

/** Tool names in first-appearance order, from a list of entries. */
function uniqueTools(entries) {
  const tools = [];
  for (const entry of entries) {
    const tool = typeof entry?.tool === "string" ? entry.tool : "";
    if (tool !== "" && !tools.includes(tool)) tools.push(tool);
  }
  return tools;
}

/**
 * Give a record its cumulative counters, seeding them from the entries it
 * already carries. A record restored from an older snapshot has entries and
 * neither counter; this is where it gains them, and the counts start out
 * exactly right for the entries it holds.
 */
function upgradeCounters(record) {
  let changed = false;
  if (!Array.isArray(record.panhandles)) {
    record.panhandles = [];
    changed = true;
  }
  if (!Number.isInteger(record.panhandleTotal) || record.panhandleTotal < 0) {
    record.panhandleTotal = record.panhandles.length;
    changed = true;
  }
  if (!Array.isArray(record.panhandleTools)) {
    record.panhandleTools = uniqueTools(record.panhandles);
    changed = true;
  }
  return changed;
}

/**
 * Record one call that ran past its turns. The panhandle count records
 * admissions: one entry per distinct call, never one per retry, so a reloaded
 * branch shows the same number its caller will read.
 *
 * The count is cumulative for the whole branch; the entry list keeps the most
 * recent `MAX_PANHANDLES` admissions only. Retry dedupe reads that window, so
 * a retry of an admission that has already fallen out of it counts again. That
 * is the one thing the window cannot do, and it needs 16 further admissions of
 * other calls to happen.
 */
export function notePanhandled(record, tool, options = {}) {
  if (!record || typeof record !== "object") {
    return failure("UNKNOWN_FORK", "No branch record to mark.");
  }
  if (!isNonEmptyString(tool)) {
    return failure("INVALID_TOOL", "A panhandled call must name its tool.");
  }
  const at = Number.isFinite(options.now) ? options.now : Date.now();
  const callId = typeof options.callId === "string" && options.callId !== "" ? options.callId : null;
  // One entry per call: a call that both ran past its turns and ended past
  // the deadline is one debt, not two.
  //
  // The whole step goes through the door, so the mark is part of the write
  // rather than a call the next path has to remember. The callback returns
  // false when it changed nothing — a duplicate admission of a record whose
  // counters were already in place — and the door then marks nothing; a
  // duplicate that had to seed legacy counters returns true, because that
  // seeding is a real change a reload has to see.
  //
  // The callback receives the same object the caller holds, so a record
  // reference taken elsewhere keeps observing these writes.
  editRecord(record, (target) => {
    const upgraded = upgradeCounters(target);
    if (callId !== null && target.panhandles.some((entry) => entry?.callId === callId)) {
      return upgraded;
    }
    target.panhandles.push(callId === null ? { at, tool } : { at, tool, callId });
    target.panhandleTotal += 1;
    if (!target.panhandleTools.includes(tool)) target.panhandleTools.push(tool);
    if (target.panhandles.length > MAX_PANHANDLES) {
      target.panhandles.splice(0, target.panhandles.length - MAX_PANHANDLES);
    }
    return true;
  });
  return { ok: true, count: record.panhandleTotal, tool };
}

/**
 * Read-only view of the panhandle count, for a receipt or a summary line.
 *
 * A record from before the counters existed reports its entries; a record that
 * has counted past the window reports the cumulative total.
 */
export function panhandleCount(record) {
  const entries = Array.isArray(record?.panhandles) ? record.panhandles : [];
  const counted =
    Number.isInteger(record?.panhandleTotal) && record.panhandleTotal >= 0;
  const tools = Array.isArray(record?.panhandleTools)
    ? record.panhandleTools.filter((tool) => typeof tool === "string" && tool !== "")
    : uniqueTools(entries);
  return { count: counted ? record.panhandleTotal : entries.length, tools: [...tools] };
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
export function grantBudget(record, request = {}, options = {}) {
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
      "Name at least one tool budget, or ask for seconds.",
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
      "This branch has no wall clock to extend; ask for tool budget instead.",
    );
  }

  // Validation is complete, so the whole mutation is one step behind the door:
  // the mark cannot be skipped, and the callback writes into the very object
  // the caller passed, so a budget map other modules already hold keeps
  // observing the grant.
  editRecord(record, (target) => {
    if (!isPlainObject(target.budget)) target.budget = {};
    if (!isPlainObject(target.remaining)) target.remaining = copyCounts(target.budget);
    for (const tool of Object.keys(tools)) {
      const added = tools[tool];
      put(
        target.budget,
        tool,
        (Object.hasOwn(target.budget, tool) ? target.budget[tool] : 0) + added,
      );
      put(
        target.remaining,
        tool,
        (Object.hasOwn(target.remaining, tool) ? target.remaining[tool] : 0) + added,
      );
    }
    if (seconds > 0) {
      target.timeBudgetMs =
        (Number.isFinite(target.timeBudgetMs) ? target.timeBudgetMs : 0) +
        seconds * 1000;
      if (Number.isFinite(target.deadlineAt)) {
        target.deadlineAt += seconds * 1000;
      }
      // A grant that moves the deadline back into the future ends overtime.
      target.overtimeAt = null;
    }
  });
  return { ok: true, tools: { ...tools }, seconds, record };
}
