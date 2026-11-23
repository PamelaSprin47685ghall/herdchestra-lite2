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

// Scope size stays O(1) at every depth. A child's budget and clock are minted
// with the item that starts it, so a large plan splits into deeper subtrees
// instead of a wider or fatter scope. These are the numbers the prompt states,
// and the caps are soft: an over-cap fork still runs, and its receipt says so.
export const SCOPE_DEFAULT_BUDGET_POINTS = 18;
export const SCOPE_MAX_BUDGET_POINTS = 27;
export const FORK_DEFAULT_FANOUT = 4;
export const FORK_MAX_FANOUT = 6;

// Tree depth is the one dimension whose default is a target, not a floor. A
// small job must not grow a relay layer just to look organized: two layers is
// ordinary, three already covers a large one, and deeper is allowed when the
// work truly needs it without a written justification.
export const FORK_DEFAULT_DEPTH = 2;
export const FORK_RECOMMENDED_DEPTH = 3;

export function isFreeTool(name) {
  return (
    CONTROL_TOOLS.has(name) ||
    name === "scope_panhandle" ||
    name === "todo" ||
    name === "ask" ||
    name === "wait"
  );
}

// Built-in protocol URIs the runtime resolves itself. A `read` or `write` on
// one of them addresses harness state — skill text, the shared artifact store,
// a child's record or transcript, a job's streams, settings, an issue, an MCP
// resource, a remote host's file, a staged ast_edit preview — through the
// protocol layer instead of the project tree. That is instruction reading and
// bookkeeping, not project work, so the call is free at every level, exactly
// like a control tool. The path decides, not the call site: a scope minted with
// no budget for `read` or `write` still runs the call, and the root still runs
// it without a fork.
//
// `http(s)://` and `file:` are deliberately absent: they fetch a live page or
// name a local file outside the protocol layer, which is work wherever it
// lands. A plain filesystem path stays charged as before.
const INTERNAL_URI_SCHEMES = new Set([
  "agent",
  "cfg",
  "help",
  "history",
  "issue",
  "local",
  "mcp",
  "omp",
  "pr",
  "proc",
  "skill",
  "ssh",
  "xd",
]);

/** The scheme of a built-in protocol URI, or null for any other path. */
export function internalScheme(path) {
  if (typeof path !== "string") return null;
  const end = path.indexOf("://");
  if (end <= 0) return null;
  const scheme = path.slice(0, end).toLowerCase();
  return INTERNAL_URI_SCHEMES.has(scheme) ? scheme : null;
}

/**
 * A read or write on a built-in protocol URI spends no tool point.
 *
 * Resolving a staged ast_edit preview belongs here as well: the harness refuses
 * to run any other tool until it lands, so charging it would deadlock a scope
 * with no write budget on its own proposal.
 */
export function isInternalUriCall(toolName, input) {
  if (toolName !== "read" && toolName !== "write") return false;
  return (
    input !== null &&
    typeof input === "object" &&
    internalScheme(input.path) !== null
  );
}

export function isFreeCall(toolName, input) {
  return isFreeTool(toolName) || isInternalUriCall(toolName, input);
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
export function normalizeToolName(toolName) {
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

export { CHARGE_SCALE, validBudget, normalizeBudget };
