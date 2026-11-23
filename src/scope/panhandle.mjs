// Scope panhandle: a branch with an empty account stands on the corner and
// asks passers-by for its next budget.
//
// The grant lands at once. The branch waits for no decision, and no other
// account shrinks: this is a declaration update, not a transfer from the
// parent. The tool is free, so a branch with nothing left can still ask.
//
// Two bounds keep one instruction from turning a measured budget into an
// unbounded one: a total for each request, and a cap for seconds. A branch can
// ask again, and what a request asks past the total still lands — the receipt
// names the number and the caller sees the tally. Seconds alone are refused.
// Every grant stays on the record, so the account text shows how often it had
// to.

import {
  SCOPE_MAX_BUDGET_POINTS,
  isFreeTool,
  normalizeToolName,
} from "./budget.mjs";
import { forkOf } from "./forkjoin.mjs";
import { sumBudgetPoints } from "./turn-stats.mjs";
import {
  copyCounts,
  failure,
  isNonEmptyString,
  isPlainObject,
  put,
} from "./state.mjs";

// One request carries a total, not a per-tool allowance: nine points of
// "read" or six of "read" and three of "edit" are the same size. Over the total
// the grant still lands; the receipt rebukes it and the record keeps the tally.
export const PANHANDLE_DEFAULT_POINTS = 6;
export const PANHANDLE_MAX_POINTS = 9;
export const PANHANDLE_MAX_SECONDS = 300;

const RUNNING = "running";

/**
 * Read and validate the requested tool points. Keys merge after name
 * normalization, so `apply_patch` and `edit` share one cap.
 */
function readTools(value) {
  if (value === undefined) return { ok: true, tools: {} };
  if (!isPlainObject(value)) {
    return failure(
      "PANHANDLE_INVALID_TOOLS",
      "tools must be a plain object of whole budget points.",
    );
  }
  const tools = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !isNonEmptyString(key)) {
      return failure("PANHANDLE_INVALID_TOOLS", "Each tool key must name a tool.");
    }
    const amount = value[key];
    if (!Number.isInteger(amount) || amount <= 0) {
      return failure(
        "PANHANDLE_INVALID_TOOLS",
        `"${key}" must be a whole number of budget points, at least 1.`,
      );
    }
    const tool = normalizeToolName(key);
    if (isFreeTool(tool)) {
      return failure(
        "PANHANDLE_FREE_TOOL",
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
      "PANHANDLE_INVALID_SECONDS",
      "seconds must be a whole number of seconds, at least 1.",
    );
  }
  if (value > PANHANDLE_MAX_SECONDS) {
    return failure(
      "PANHANDLE_SECONDS_LIMIT",
      `One panhandle grants at most ${PANHANDLE_MAX_SECONDS} seconds.`,
    );
  }
  return { ok: true, seconds: value };
}

/**
 * Validate and add tool points and seconds to one record's account. The
 * caller owns the status gate; validation runs before any mutation.
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
      "PANHANDLE_EMPTY",
      "Name at least one tool budget or ask for seconds.",
    );
  }
  if (
    seconds > 0 &&
    !Number.isFinite(record.deadlineAt) &&
    record.status !== "blocked" &&
    options?.allowClockOff !== true
  ) {
    return failure(
      "PANHANDLE_CLOCK_OFF",
      "This branch has no wall clock to extend; ask for tool budget instead.",
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
  // A reuse grows one scope, so its overage is the scope's own total. A
  // panhandle is metered over the whole request, whichever tools it names.
  const pointsRequested = sumBudgetPoints(tools);
  const totalPoints = sumBudgetPoints(record.budget);
  const overLimit =
    options?.scopeCap === true || options?.totalCap === true
      ? pointsRequested > 0 && totalPoints > SCOPE_MAX_BUDGET_POINTS
      : pointsRequested > PANHANDLE_MAX_POINTS;
  return {
    ok: true,
    tools: { ...tools },
    seconds,
    pointsRequested,
    overLimit,
    totalPoints,
    record,
  };
}

/**
 * Panhandle entry: the caller funds its own running branch, and the grant
 * stays on the record for the budget line.
 */
export function applyPanhandle(ledger, forkId, request = {}, options = {}) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  if (record.status === "blocked") {
    return failure(
      "PANHANDLE_BLOCKED",
      "This branch is blocked and has not started; declare the budget when you resubmit the fork.",
    );
  }
  if (record.status !== RUNNING) {
    return failure(
      "PANHANDLE_CLOSED",
      `This branch is ${record.status} and no longer spends budget.`,
    );
  }
  const granted = grantBudget(record, request, options);
  if (!granted.ok) return granted;
  if (!Array.isArray(record.panhandles)) record.panhandles = [];
  const at = Number.isFinite(options.now) ? options.now : Date.now();
  record.panhandles.push({
    at,
    tools: { ...granted.tools },
    seconds: granted.seconds,
  });
  return {
    ok: true,
    tools: granted.tools,
    seconds: granted.seconds,
    count: record.panhandles.length,
    pointsRequested: granted.pointsRequested,
    overLimit: granted.overLimit,
    totalPoints: granted.totalPoints,
    record,
  };
}
