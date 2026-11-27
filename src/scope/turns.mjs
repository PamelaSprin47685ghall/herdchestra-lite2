// Scope turns: normalization, rounding, per-beat shares, and display.
// Pure arithmetic. No I/O.

import { CONTROL_TOOLS } from "./state.mjs";
import {
  formatCents as formatAmount,
  normalizeBudget,
  put,
  roundAmount,
  validBudget,
} from "../core/primitives.mjs";

// Charge amounts are real numbers with at most two decimal places. One turn is
// split into 100 hundredths so an assistant message spends exactly one turn
// however its tools divide it.
const CHARGE_SCALE = 100;

// A scope keeps the control tools and the protocol reads for free; every other
// call is charged. Size is a judgement, not a constant, and no code in this
// module computes one: `resources/prompts/system.md` §Run scopes holds the rule
// and its multiplier.
export function isFreeTool(name) {
  return (
    CONTROL_TOOLS.has(name) ||
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
// no turns for `read` or `write` still runs the call, and the root still runs
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
 * A read or write on a built-in protocol URI spends no turn.
 *
 * Resolving a staged ast_edit preview belongs here as well: the harness refuses
 * to run any other tool until it lands, so charging it would deadlock a scope
 * with no turn for `write` on its own proposal.
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

  /** Normalize a single tool name: apply_patch → edit. */
  export function normalizeToolName(toolName) {
    return toolName === "apply_patch" ? "edit" : toolName;
  }

/**
 * Split one turn across the tools called in a single assistant
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

export { CHARGE_SCALE, validBudget, normalizeBudget, roundAmount, formatAmount };
