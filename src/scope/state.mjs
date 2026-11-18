// Scope state: creation, inspection, and the base copy helpers.
// Pure data. No I/O.

import { createRelay } from "../relay/state.mjs";

const VERSION = 2;

const CONTROL_TOOLS = new Set(["scope", "regret", "defer", "pin"]);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function failure(code, reason) {
  return { ok: false, code, reason };
}

// Define an own data property. This is safe for keys such as "__proto__".
function put(object, key, value) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function copyCounts(source) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") continue;
    put(out, key, source[key]);
  }
  return out;
}

function copyDefers(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => ({
    toolCallId: item.toolCallId,
    intent: item.intent,
  }));
}

function makeScope(state, toolCallId, intent, budget) {
  const spent = {};
  for (const tool of Reflect.ownKeys(budget)) {
    if (typeof tool === "string") put(spent, tool, 0);
  }
  return {
    id: `scope-${++state.seq}`,
    boundary:
      Number.isInteger(state.relay?.generation) && state.relay.generation >= 0
        ? state.relay.generation
        : 0,
    epoch:
      Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0,
    intent: intent.trim(),
    beginToolCallId: typeof toolCallId === "string" ? toolCallId : "",
    budget: copyCounts(budget),
    remaining: copyCounts(budget),
    spent,
    defers: [],
    residualDefers: [],
  };
}

export function createState() {
  return {
    version: VERSION,
    seq: 0,
    epoch: 0,
    scopes: [],
    charges: {},
    regrets: [],
    collapses: [],
    relay: createRelay(),
  };
}

export function currentScope(state) {
  if (!state || !Array.isArray(state.scopes) || state.scopes.length === 0) {
    return null;
  }
  return state.scopes[state.scopes.length - 1];
}

/** Return a scope's creation order, derived from its generated id. */
export function scopeOrder(scope) {
  const match = /^scope-(\d+)$/.exec(String(scope?.id ?? ""));
  return match ? Number(match[1]) : 0;
}

export {
  VERSION,
  CONTROL_TOOLS,
  isPlainObject,
  isNonEmptyString,
  failure,
  put,
  copyCounts,
  copyDefers,
  makeScope,
};
