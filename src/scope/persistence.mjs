// Scope persistence: snapshot validation, serialization, and restoration.
// Pure data. No I/O.

import {
  VERSION,
  isPlainObject,
  isNonEmptyString,
  put,
  copyCounts,
  copyDefers,
  createState,
} from "./state.mjs";
import { copyRelay, createRelay, isValidRelay } from "../relay/state.mjs";

function copyCharges(source) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") continue;
    const charge = source[key];
    if (!isPlainObject(charge)) continue;
    const copied = {
      scopeId: charge.scopeId,
      tool: charge.tool,
      amount: charge.amount,
    };
    if (typeof charge.groupKey === "string") copied.groupKey = charge.groupKey;
    put(out, key, copied);
  }
  return out;
}

function copyCollapse(collapse) {
  const copied = {
    beginToolCallId: collapse.beginToolCallId,
    endToolCallId: collapse.endToolCallId,
    report: collapse.report,
    parentId:
      typeof collapse.parentId === "string" && collapse.parentId !== ""
        ? collapse.parentId
        : null,
    order:
      Number.isInteger(collapse.order) && collapse.order >= 0
        ? collapse.order
        : 0,
    collapsed: collapse.collapsed !== false,
    createdAt: collapse.createdAt,
    boundary:
      Number.isInteger(collapse.boundary) && collapse.boundary >= 0
        ? collapse.boundary
        : 0,
    epoch:
      Number.isInteger(collapse.epoch) && collapse.epoch >= 0
        ? collapse.epoch
        : 0,
  };
  // Optional measured fields. Copy only when present so legacy snapshots
  // (which lack them) round-trip unchanged.
  for (const key of [
    "scopeId",
    "intent",
    "sealed",
    "interiorTokens",
    "interiorChars",
    "pinTokens",
    "paidRentCost",
    "baseInputTokens",
    "preBeginInputTokens",
    "endInputTokens",
    "endInputTokensPending",
  ]) {
    if (collapse[key] !== undefined) put(copied, key, collapse[key]);
  }
  return copied;
}

// Scope-level measured fields follow the same presence-only rule.
function measuredFields(source) {
  const out = {};
  for (const key of [
    "baseInputTokens",
    "preBeginInputTokens",
    "endInputTokens",
    "endInputTokensPending",
    "beginResultChars",
  ]) {
    if (source[key] !== undefined) put(out, key, source[key]);
  }
  return out;
}

export function serializeState(state) {
  return {
    version: VERSION,
    seq: state.seq ?? 0,
    scopes: (state.scopes ?? []).map((scope) => ({
      id: scope.id,
      boundary:
        Number.isInteger(scope.boundary) && scope.boundary >= 0
          ? scope.boundary
          : 0,
      epoch:
        Number.isInteger(scope.epoch) && scope.epoch >= 0 ? scope.epoch : 0,
      intent: scope.intent,
      beginToolCallId: scope.beginToolCallId,
      budget: copyCounts(scope.budget),
      remaining: copyCounts(scope.remaining),
      spent: copyCounts(scope.spent),
      defers: copyDefers(scope.defers),
      residualDefers: copyDefers(scope.residualDefers),
      ...measuredFields(scope),
    })),
    charges: copyCharges(state.charges),
    regrets: Array.isArray(state.regrets) ? state.regrets.slice() : [],
    collapses: Array.isArray(state.collapses)
      ? state.collapses.map(copyCollapse)
      : [],
    epoch:
      Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0,
    relay: copyRelay(state.relay),
  };
}

function validDefers(value) {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item)) return false;
    if (typeof item.toolCallId !== "string") return false;
    if (!isNonEmptyString(item.intent)) return false;
  }
  return true;
}

function validBudgetCounts(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const amount = value[key];
    if (!Number.isInteger(amount) || amount < 0) return false;
  }
  return true;
}

function validAmountCounts(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const amount = value[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return false;
    }
  }
  return true;
}

function validScope(scope) {
  if (!isPlainObject(scope)) return false;
  if (!isNonEmptyString(scope.id)) return false;
  if (!isNonEmptyString(scope.intent)) return false;
  if (
    scope.boundary !== undefined &&
    (!Number.isInteger(scope.boundary) || scope.boundary < 0)
  ) {
    return false;
  }
  if (
    scope.epoch !== undefined &&
    (!Number.isInteger(scope.epoch) || scope.epoch < 0)
  ) {
    return false;
  }
  if (typeof scope.beginToolCallId !== "string") return false;
  if (!validBudgetCounts(scope.budget)) return false;
  if (!validAmountCounts(scope.remaining)) return false;
  if (!validAmountCounts(scope.spent)) return false;
  if (!validDefers(scope.defers)) return false;
  if (!validDefers(scope.residualDefers)) return false;
  // Optional measured fields must stay type-correct when present; their
  // absence is allowed so legacy snapshots migrate cleanly.
  for (const key of ["baseInputTokens", "preBeginInputTokens", "endInputTokens"]) {
    if (scope[key] === undefined || scope[key] === null) continue;
    if (typeof scope[key] !== "number" || !Number.isFinite(scope[key]) || scope[key] < 0) {
      return false;
    }
  }
  if (
    scope.endInputTokensPending !== undefined &&
    typeof scope.endInputTokensPending !== "boolean"
  ) {
    return false;
  }
  if (
    scope.beginResultChars !== undefined &&
    (typeof scope.beginResultChars !== "number" ||
      !Number.isFinite(scope.beginResultChars) ||
      scope.beginResultChars < 0)
  ) {
    return false;
  }
  return true;
}

function validCharges(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const charge = value[key];
    if (!isPlainObject(charge)) return false;
    if (!isNonEmptyString(charge.scopeId)) return false;
    if (!isNonEmptyString(charge.tool)) return false;
    if (
      typeof charge.amount !== "number" ||
      !Number.isFinite(charge.amount) ||
      charge.amount <= 0
    ) {
      return false;
    }
    if (charge.groupKey !== undefined && typeof charge.groupKey !== "string") {
      return false;
    }
  }
  return true;
}

function validCollapses(value) {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item)) return false;
    if (!isNonEmptyString(item.beginToolCallId)) return false;
    if (!isNonEmptyString(item.endToolCallId)) return false;
    // A finished report is a non-empty string; an unarchived elder has a
    // null report and must still be uncollapsed.
    const reportOk =
      isNonEmptyString(item.report) ||
      (item.report === null && item.collapsed === false);
    if (!reportOk) return false;
    if (typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)) {
      return false;
    }
    if (
      item.boundary !== undefined &&
      (!Number.isInteger(item.boundary) || item.boundary < 0)
    ) {
      return false;
    }
    if (
      item.epoch !== undefined &&
      (!Number.isInteger(item.epoch) || item.epoch < 0)
    ) {
      return false;
    }
    if (
      item.parentId !== undefined &&
      item.parentId !== null &&
      !isNonEmptyString(item.parentId)
    ) {
      return false;
    }
    if (
      item.order !== undefined &&
      (!Number.isInteger(item.order) || item.order < 0)
    ) {
      return false;
    }
    if (item.collapsed !== undefined && typeof item.collapsed !== "boolean") {
      return false;
    }
    if (item.sealed !== undefined && typeof item.sealed !== "boolean") {
      return false;
    }
    if (
      item.scopeId !== undefined &&
      item.scopeId !== null &&
      typeof item.scopeId !== "string"
    ) {
      return false;
    }
    if (item.intent !== undefined && typeof item.intent !== "string") {
      return false;
    }
    for (const key of [
      "interiorTokens",
      "baseInputTokens",
      "preBeginInputTokens",
      "endInputTokens",
    ]) {
      if (item[key] === undefined || item[key] === null) continue;
      if (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0) {
        return false;
      }
    }
    for (const key of ["interiorChars", "pinTokens", "paidRentCost"]) {
      if (item[key] === undefined) continue;
      if (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0) {
        return false;
      }
    }
    if (
      item.endInputTokensPending !== undefined &&
      typeof item.endInputTokensPending !== "boolean"
    ) {
      return false;
    }
  }
  return true;
}

export function deserializeState(input) {
  try {
    let data = input;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return createState();
      }
    }
    if (
      !isPlainObject(data) ||
      (data.version !== 1 && data.version !== VERSION)
    ) {
      return createState();
    }
    // Version 1 predates the relay state. Its other fields keep their meaning,
    // so migrate them instead of discarding the scope history.
    if (data.version === VERSION && !isValidRelay(data.relay)) {
      return createState();
    }
    if (!Number.isInteger(data.seq) || data.seq < 0) return createState();
    if (!Array.isArray(data.scopes) || !data.scopes.every(validScope)) {
      return createState();
    }
    if (!validCharges(data.charges)) return createState();
    if (
      !Array.isArray(data.regrets) ||
      !data.regrets.every((key) => typeof key === "string")
    ) {
      return createState();
    }
    if (!validCollapses(data.collapses)) return createState();
    if (
      data.epoch !== undefined &&
      (!Number.isInteger(data.epoch) || data.epoch < 0)
    ) {
      return createState();
    }
    return {
      version: VERSION,
      seq: data.seq,
      epoch:
        Number.isInteger(data.epoch) && data.epoch >= 0 ? data.epoch : 0,
      scopes: data.scopes.map((scope) => ({
        id: scope.id,
        boundary:
          Number.isInteger(scope.boundary) && scope.boundary >= 0
            ? scope.boundary
            : 0,
        epoch:
          Number.isInteger(scope.epoch) && scope.epoch >= 0 ? scope.epoch : 0,
        intent: scope.intent,
        beginToolCallId: scope.beginToolCallId,
        budget: copyCounts(scope.budget),
        remaining: copyCounts(scope.remaining),
        spent: copyCounts(scope.spent),
        defers: copyDefers(scope.defers),
        residualDefers: copyDefers(scope.residualDefers),
        ...measuredFields(scope),
      })),
      charges: copyCharges(data.charges),
      regrets: data.regrets.slice(),
      collapses: data.collapses.map(copyCollapse),
      relay: data.version === VERSION ? copyRelay(data.relay) : createRelay(),
    };
  } catch {
    return createState();
  }
}
