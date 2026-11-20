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
import { WORKFLOW_STAGES } from "./stages.mjs";
import { copyStageFlags } from "./stage-flags.mjs";

function copyPins(pins) {
  return Array.isArray(pins) ? pins.filter(isNonEmptyString) : [];
}

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
    "pinChars",
    "userChars",
    "paidRentCost",
    "baseInputTokens",
    "preBeginInputTokens",
    "endInputTokens",
    "endInputTokensPending",
    "measuredModelKey",
    "baseModelKey",
  ]) {
    if (collapse[key] !== undefined) put(copied, key, collapse[key]);
  }
  return copied;
}

// Scope-level measured and model-identity fields follow the same
// presence-only rule.
function measuredFields(source) {
  const out = {};
  for (const key of [
    "timeBudgetMs",
    "openedAt",
    "deadlineAt",
    "overtimeAt",
    "baseInputTokens",
    "preBeginInputTokens",
    "endInputTokens",
    "endInputTokensPending",
    "beginResultChars",
    "modelSpec",
    "modelKey",
    "previousModelSpec",
    "previousModelKey",
    "baseModelKey",
  ]) {
    if (source[key] !== undefined) put(out, key, source[key]);
  }
  return out;
}

// Model cache entries: { cachedUntilPos, lastUsedAt, tokensPerChar }.
function copyModelCaches(source) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string" || key === "") continue;
    const entry = source[key];
    if (!isPlainObject(entry)) continue;
    const copied = {};
    if (Number.isInteger(entry.cachedUntilPos) && entry.cachedUntilPos >= 0) {
      put(copied, "cachedUntilPos", entry.cachedUntilPos);
    }
    if (Number.isFinite(entry.lastUsedAt) && entry.lastUsedAt >= 0) {
      put(copied, "lastUsedAt", entry.lastUsedAt);
    }
    if (Number.isFinite(entry.tokensPerChar) && entry.tokensPerChar >= 0) {
      put(copied, "tokensPerChar", entry.tokensPerChar);
    }
    if (Object.keys(copied).length > 0) put(out, key, copied);
  }
  return out;
}

function copyModelRecovery(source) {
  if (!isPlainObject(source)) return null;
  const out = {};
  if (typeof source.targetSpec === "string" || source.targetSpec === null) {
    put(out, "targetSpec", source.targetSpec ?? null);
  }
  if (typeof source.expectedKey === "string" || source.expectedKey === null) {
    put(out, "expectedKey", source.expectedKey ?? null);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function serializeState(state) {
  return {
    version: VERSION,
    startedAt: Number.isFinite(state.startedAt) ? state.startedAt : Date.now(),
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
      stage: WORKFLOW_STAGES.includes(scope.stage) ? scope.stage : null,
      beginToolCallId: scope.beginToolCallId,
      budget: copyCounts(scope.budget),
      remaining: copyCounts(scope.remaining),
      spent: copyCounts(scope.spent),
      defers: copyDefers(scope.defers),
      residualDefers: copyDefers(scope.residualDefers),
      ...measuredFields(scope),
    })),
    charges: copyCharges(state.charges),
    amends: Array.isArray(state.amends) ? state.amends.slice() : [],
    collapses: Array.isArray(state.collapses)
      ? state.collapses.map(copyCollapse)
      : [],
    epoch:
      Number.isInteger(state.epoch) && state.epoch >= 0 ? state.epoch : 0,
    herdMode: state.herdMode === true,
    pins: copyPins(state.pins),
    relay: copyRelay(state.relay),
    baseModelSpec:
      typeof state.baseModelSpec === "string" ? state.baseModelSpec : null,
    baseModelKey:
      typeof state.baseModelKey === "string" && state.baseModelKey !== ""
        ? state.baseModelKey
        : null,
    modelRecovery: copyModelRecovery(state.modelRecovery),
    modelCaches: copyModelCaches(state.modelCaches),
    stageFlags: copyStageFlags(state.stageFlags),
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
  for (const key of ["timeBudgetMs", "openedAt", "deadlineAt", "overtimeAt"]) {
    if (scope[key] === undefined || scope[key] === null) continue;
    if (typeof scope[key] !== "number" || !Number.isFinite(scope[key]) || scope[key] <= 0) {
      return false;
    }
  }
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
  // Optional model identity fields must be string-or-null when present.
  for (const key of [
    "modelSpec",
    "modelKey",
    "previousModelSpec",
    "previousModelKey",
    "baseModelKey",
  ]) {
    if (scope[key] === undefined) continue;
    if (scope[key] !== null && typeof scope[key] !== "string") return false;
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

function validModelCaches(value) {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "") return false;
    const entry = value[key];
    if (!isPlainObject(entry)) return false;
    if (
      entry.cachedUntilPos !== undefined &&
      (!Number.isInteger(entry.cachedUntilPos) || entry.cachedUntilPos < 0)
    ) {
      return false;
    }
    if (
      entry.lastUsedAt !== undefined &&
      (!Number.isFinite(entry.lastUsedAt) || entry.lastUsedAt < 0)
    ) {
      return false;
    }
    if (
      entry.tokensPerChar !== undefined &&
      (typeof entry.tokensPerChar !== "number" ||
        !Number.isFinite(entry.tokensPerChar) ||
        entry.tokensPerChar < 0)
    ) {
      return false;
    }
  }
  return true;
}

function validModelRecovery(value) {
  if (value === undefined || value === null) return true;
  if (!isPlainObject(value)) return false;
  for (const key of ["targetSpec", "expectedKey"]) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
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
    for (const key of ["interiorChars", "pinTokens", "pinChars", "userChars", "paidRentCost"]) {
      if (item[key] === undefined) continue;
      if (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0) {
        return false;
      }
    }
    if (
      item.measuredModelKey !== undefined &&
      item.measuredModelKey !== null &&
      typeof item.measuredModelKey !== "string"
    ) {
      return false;
    }
    if (
      item.baseModelKey !== undefined &&
      item.baseModelKey !== null &&
      typeof item.baseModelKey !== "string"
    ) {
      return false;
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
    const amends = Array.isArray(data.amends) ? data.amends : [];
    if (!Array.isArray(amends) || !amends.every((key) => typeof key === "string")) {
      return createState();
    }
    if (!validCollapses(data.collapses)) return createState();
    if (
      data.epoch !== undefined &&
      (!Number.isInteger(data.epoch) || data.epoch < 0)
    ) {
      return createState();
    }
    if (!validModelCaches(data.modelCaches)) return createState();
    if (!validModelRecovery(data.modelRecovery)) return createState();
    for (const key of ["baseModelSpec", "baseModelKey"]) {
      if (
        data[key] !== undefined &&
        data[key] !== null &&
        typeof data[key] !== "string"
      ) {
        return createState();
      }
    }
    return {
      version: VERSION,
      startedAt: Number.isFinite(data.startedAt) ? data.startedAt : Date.now(),
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
        stage: WORKFLOW_STAGES.includes(scope.stage) ? scope.stage : null,
        beginToolCallId: scope.beginToolCallId,
        budget: copyCounts(scope.budget),
        remaining: copyCounts(scope.remaining),
        spent: copyCounts(scope.spent),
        defers: copyDefers(scope.defers),
        residualDefers: copyDefers(scope.residualDefers),
        ...measuredFields(scope),
      })),
      charges: copyCharges(data.charges),
      amends: amends.slice(),
      collapses: data.collapses.map(copyCollapse),
      herdMode: data.herdMode === true,
      pins: copyPins(data.pins),
      relay: data.version === VERSION ? copyRelay(data.relay) : createRelay(),
      baseModelSpec:
        typeof data.baseModelSpec === "string" ? data.baseModelSpec : null,
      baseModelKey:
        typeof data.baseModelKey === "string" && data.baseModelKey !== ""
          ? data.baseModelKey
          : null,
      modelRecovery: copyModelRecovery(data.modelRecovery),
      modelCaches: copyModelCaches(data.modelCaches),
      stageFlags: copyStageFlags(data.stageFlags),
    };
  } catch {
    return createState();
  }
}

// -- Append-only state entries ---------------------------------------------
//
// The host session is a tree of entries linked by `parentId`, and
// `appendCustomEntry` only ever adds a child. A full snapshot per turn grows
// the session file by the whole state each time. These helpers write what
// changed instead: a delta against the previous snapshot, with a periodic
// checkpoint that bounds replay length.
//
// A checkpoint carries the full serialized state. A delta carries JSON-patch
// style operations over that state. A legacy entry carries the state alone,
// with no envelope, and still restores.

export const STATE_ENTRY_VERSION = 2;
export const CHECKPOINT_EVERY = 64;
export const MAX_DELTA_OPS = 32;
export const MAX_DELTA_BYTES = 16 * 1024;

function isStateEnvelope(value) {
  return (
    isPlainObject(value) &&
    value.version === STATE_ENTRY_VERSION &&
    (value.kind === "checkpoint" || value.kind === "delta")
  );
}

/** True when an entry can anchor a replay: a checkpoint or a legacy snapshot. */
export function isStateCheckpoint(value) {
  if (!isStateEnvelope(value)) return true;
  return value.kind === "checkpoint";
}

/** Wrap any stored payload as an envelope a chain reader understands. */
export function normalizeStateEntry(value) {
  if (isStateEnvelope(value)) return value;
  return {
    version: STATE_ENTRY_VERSION,
    kind: "checkpoint",
    state: value,
  };
}

function diffInto(prev, next, path, ops) {
  if (prev === next) return;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const common = Math.min(prev.length, next.length);
    for (let index = 0; index < common; index += 1) {
      diffInto(prev[index], next[index], [...path, index], ops);
    }
    for (let index = common; index < next.length; index += 1) {
      ops.push({ op: "set", path: [...path, index], value: next[index] });
    }
    if (next.length < prev.length) {
      ops.push({ op: "trunc", path, length: next.length });
    }
    return;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    for (const key of Object.keys(next)) {
      if (Object.hasOwn(prev, key)) {
        diffInto(prev[key], next[key], [...path, key], ops);
      } else {
        ops.push({ op: "set", path: [...path, key], value: next[key] });
      }
    }
    for (const key of Object.keys(prev)) {
      if (!Object.hasOwn(next, key)) {
        ops.push({ op: "del", path: [...path, key] });
      }
    }
    return;
  }
  ops.push({ op: "set", path, value: next });
}

/** Operations that turn `prev` into `next`. Both are serialized states. */
export function diffState(prev, next) {
  const ops = [];
  diffInto(prev, next, [], ops);
  return ops;
}

function cloneValue(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

/** Apply operations to a copy of `base`. The input is never mutated. */
export function applyDelta(base, ops) {
  const root = cloneValue(base);
  if (!Array.isArray(ops)) return root;
  for (const op of ops) {
    if (!Array.isArray(op?.path) || op.path.length === 0) continue;
    if (op.op === "trunc") {
      // A truncation names the array itself, not a key inside it.
      let target = root;
      for (const key of op.path) {
        target = target?.[key];
        if (target === undefined || target === null) break;
      }
      if (Array.isArray(target)) target.length = op.length;
      continue;
    }
    let parent = root;
    for (let index = 0; index < op.path.length - 1; index += 1) {
      parent = parent?.[op.path[index]];
      if (parent === undefined || parent === null) break;
    }
    if (parent === undefined || parent === null) continue;
    const key = op.path[op.path.length - 1];
    if (op.op === "set") {
      parent[key] = op.value;
    } else if (op.op === "del") {
      delete parent[key];
    }
  }
  return root;
}

/**
 * Choose the next entry for `next`.
 *
 * Returns null when nothing changed, so an idle turn writes nothing.
 */
export function planStateEntry(prev, next, writesSinceCheckpoint = 0) {
  if (!prev) {
    return { version: STATE_ENTRY_VERSION, kind: "checkpoint", state: next };
  }
  const ops = diffState(prev, next);
  if (ops.length === 0) return null;
  const bytes = JSON.stringify(ops).length;
  if (
    writesSinceCheckpoint >= CHECKPOINT_EVERY - 1 ||
    ops.length > MAX_DELTA_OPS ||
    bytes > MAX_DELTA_BYTES
  ) {
    return { version: STATE_ENTRY_VERSION, kind: "checkpoint", state: next };
  }
  return { version: STATE_ENTRY_VERSION, kind: "delta", ops };
}

/**
 * Replay a chain, oldest first, into one serialized state.
 *
 * @param {unknown[]} entries Stored payloads, oldest first.
 * @returns {object|null} The state, or null when a delta has no anchor.
 */
export function foldStateChain(entries) {
  let base = null;
  for (const raw of entries) {
    const entry = normalizeStateEntry(raw);
    if (entry.kind === "delta") {
      if (base === null) return null;
      base = applyDelta(base, entry.ops);
    } else {
      base = entry.state;
    }
  }
  return base;
}
