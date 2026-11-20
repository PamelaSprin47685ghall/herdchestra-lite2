// Scope budget: normalization, rounding, per-beat shares, and display.
// Pure arithmetic. No I/O.

import {
  CONTROL_TOOLS,
  isPlainObject,
  isNonEmptyString,
  put,
} from "./state.mjs";

// Charge amounts are real numbers with at most two decimal places. One budget
// unit is split into 100 hundredths so an assistant turn spends exactly one
// unit however its tools divide it.
const CHARGE_SCALE = 100;

export function isFreeTool(name) {
  return CONTROL_TOOLS.has(name) || name === "todo" || name === "ask" || name === "wait";
}

// Resolving a staged ast_edit preview is a bookkeeping write, not work: the
// harness refuses to run any other tool until it lands. Charging it would let a
// scope with no write budget deadlock on its own proposal.
const RESOLUTION_WRITE_PATHS = new Set(["xd://resolve", "xd://reject"]);

export function isResolutionWrite(toolName, input) {
  return (
    toolName === "write" &&
    input !== null &&
    typeof input === "object" &&
    RESOLUTION_WRITE_PATHS.has(input.path)
  );
}

export function isFreeCall(toolName, input) {
  return isFreeTool(toolName) || isResolutionWrite(toolName, input);
}

function validBudget(budget) {
  if (!isPlainObject(budget)) return false;
  for (const tool of Reflect.ownKeys(budget)) {
    if (typeof tool !== "string" || !isNonEmptyString(tool)) return false;
    const amount = budget[tool];
    if (!Number.isInteger(amount) || amount < 0) return false;
  }
  return true;
}

/** Normalize tool names: apply_patch → edit. */
function normalizeBudget(budget) {
  if (!isPlainObject(budget)) return budget;
  const normalized = {};
  for (const key of Reflect.ownKeys(budget)) {
    if (typeof key !== "string") continue;
    const normalizedKey = key === "apply_patch" ? "edit" : key;
    const currentValue = Object.hasOwn(normalized, normalizedKey) ? normalized[normalizedKey] : 0;
    put(normalized, normalizedKey, currentValue + budget[key]);
  }
  return normalized;
}

/** Normalize a single tool name: apply_patch → edit. */
function normalizeToolName(toolName) {
  return toolName === "apply_patch" ? "edit" : toolName;
}

/** Round a charge amount to the two-decimal budget precision. */
export function roundAmount(value) {
  return Math.round(value * CHARGE_SCALE) / CHARGE_SCALE;
}

/** Render an amount with the fixed two-decimal display precision. */
export function formatAmount(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

/**
 * Split one budget unit across the tools called in a single assistant
 * message, in proportion to their call counts. The shares sum to exactly one
 * unit. Free tools take no share.
 */
export function beatShares(items) {
  const counts = new Map();
  let total = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const name = typeof item === "string" ? item : item?.name;
    if (typeof name !== "string" || name === "") continue;
    const free =
      typeof item === "string" ? isFreeTool(name) : item.free ?? isFreeTool(name);
    if (free) continue;
    const tool = normalizeToolName(name);
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return {};
  const shares = {};
  let assigned = 0;
  let largestTool = null;
  let largestCount = 0;
  for (const [tool, count] of counts) {
    const part = Math.max(1, Math.round((count * CHARGE_SCALE) / total));
    put(shares, tool, part);
    assigned += part;
    if (count > largestCount) {
      largestCount = count;
      largestTool = tool;
    }
  }
  // Hand the rounding residue to the most frequent tool so the shares always
  // add up to one unit.
  const correction = CHARGE_SCALE - assigned;
  if (correction !== 0) {
    put(shares, largestTool, Math.max(0, shares[largestTool] + correction));
  }
  for (const tool of Object.keys(shares)) {
    put(shares, tool, roundAmount(shares[tool] / CHARGE_SCALE));
  }
  return shares;
}

export function budgetText(scope) {
  if (!scope || !isPlainObject(scope.remaining)) return "";
  const entries = [];
  for (const tool of Reflect.ownKeys(scope.remaining).sort()) {
    if (typeof tool !== "string") continue;
    const remaining = scope.remaining[tool];
    const budget = scope.budget[tool];
    if (budget === undefined) continue;
    entries.push(
      `${tool} ${formatAmount(remaining)}/${formatAmount(budget)}`,
    );
  }
  return entries.join(", ");
}

export { CHARGE_SCALE, validBudget, normalizeBudget, normalizeToolName };
