// Fork/join bracket ledger: pairing, reparenting, sibling order, fold gates.
//
// A fork opens a left bracket. A join (parent side) or a return (child side)
// closes a right bracket. Brackets may interleave; every pair must close.
// This module is pure data and arithmetic. It holds no host objects, reads no
// clock, and performs no I/O.

import { decideAbandon } from "./abandon.mjs";
import { roleOfSegment } from "./roles.mjs";
import { isPlainObject } from "./plain.mjs";
import { emptyTotals } from "./turn-stats.mjs";
import { subscopePath } from "./path.mjs";
import {
  markLedgerStructDirty,
  markRecordDirty,
  registerLedger,
  registerRecord,
} from "./ledger-cache.mjs";

import { changed, copyCounts, failure, forkOf, isDepth, isNonEmptyString, put, validBudget } from "./ledger-charge.mjs";


export { markLedgerStructDirty, markRecordDirty, touchRecord } from "./ledger-cache.mjs";

export function touchFork(ledger, forkId) {
  if (!forkOf(ledger, forkId)) return false;
  markRecordDirty(ledger, forkId);
  return true;
}

export const RUNNING = "running";

export const READY = "ready";

export const JOINED = "joined";

export const FAILED = "failed";

function defaultRootMeta() {
  return {
    model: null,
    thinkingLevel: null,
    contextTokens: null,
    dirContextTokens: null,
    contextWindow: null,
    safeSnapshotLeafId: null,
  };
}

export function createBracketLedger() {
  const ledger = {
    version: 3,
    // Monotonic directory version: bumps on register, markReady, abandon,
    // or Root directory metadata changes.
    dirSeq: 0,
    // Monotonic event counter shared by fork registration and join
    // completion, so an interval can compare positions from both sides.
    seq: 0,
    // Right-bracket completion counter. This alone defines sibling order.
    closedSeq: 0,
    // Receive counter. It orders the ready queue across reparenting.
    receiveSeq: 0,
    root: defaultRootMeta(),
    forks: {},
    order: [],
    queues: {},
    levels: {},
    // Session-wide request timing. Shared by reference across scopes, so k
    // concurrent requests add k durations and k turns. Missing on old snapshots.
    totals: emptyTotals(),
  };
  registerLedger(ledger);
  return ledger;
}

/**
 * Update Root's metadata (`model`, `thinkingLevel`, `contextTokens`,
 * `dirContextTokens`, `contextWindow`, `safeSnapshotLeafId`).
 * Bumps `dirSeq` only when directory-visible fields (`model`, `thinkingLevel`,
 * `dirContextTokens`, `contextWindow`) change.
 */
export function updateRootMeta(ledger, fields = {}) {
  if (!ledger || typeof ledger !== "object" || !fields || typeof fields !== "object") return false;
  if (!isPlainObject(ledger.root)) ledger.root = defaultRootMeta();
  const root = ledger.root;
  let dirChanged = false;
  let anyChanged = false;
  const dirFields = ["model", "thinkingLevel", "dirContextTokens", "contextWindow"];
  const allFields = [...dirFields, "contextTokens", "safeSnapshotLeafId"];
  for (const key of allFields) {
    if (!Object.hasOwn(fields, key) || fields[key] === undefined) continue;
    if (Object.is(root[key], fields[key])) continue;
    root[key] = fields[key];
    anyChanged = true;
    if (dirFields.includes(key)) dirChanged = true;
  }
  if (!anyChanged) return false;
  if (dirChanged) {
    ledger.dirSeq = (Number.isInteger(ledger.dirSeq) ? ledger.dirSeq : 0) + 1;
  }
  markLedgerStructDirty(ledger);
  return true;
}

/**
 * Update a fork record's snapshot/model metadata. Bumps `dirSeq` only when
 * directory-visible fields (`resolvedModel`, `resolvedThinking`,
 * `contextWindow`) change, or when `snapshotContextTokens` changes on a
 * non-running record.
 */
export function updateRecordSnapshot(ledger, forkId, fields = {}) {
  const record = forkOf(ledger, forkId);
  if (!record || !fields || typeof fields !== "object") return false;
  let dirChanged = false;
  let anyChanged = false;
  const keys = [
    "safeSnapshotLeafId",
    "snapshotContextTokens",
    "resolvedModel",
    "resolvedThinking",
    "contextWindow",
  ];
  for (const key of keys) {
    if (!Object.hasOwn(fields, key) || fields[key] === undefined) continue;
    if (Object.is(record[key], fields[key])) continue;
    record[key] = fields[key];
    anyChanged = true;
    if (
      key === "resolvedModel" ||
      key === "resolvedThinking" ||
      key === "contextWindow" ||
      (key === "snapshotContextTokens" && record.status !== RUNNING)
    ) {
      dirChanged = true;
    }
  }
  if (!anyChanged) return false;
  markRecordDirty(ledger, forkId);
  if (dirChanged) {
    ledger.dirSeq = (Number.isInteger(ledger.dirSeq) ? ledger.dirSeq : 0) + 1;
    markLedgerStructDirty(ledger);
  }
  return true;
}

/**
 * Mark a running fork as having a pending `scope_abandon` request.
 * Does not change `status` (remains `running` until `scope_return` or forced close)
 * and does not bump `dirSeq`.
 */
export function requestAbandon(ledger, forkId, { by = "/", reason = null } = {}) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  if (record.status !== RUNNING) {
    return failure("SCOPE_ALREADY_DONE", `Scope "${record.path ?? forkId}" is already done.`);
  }
  if (record.abandonRequested === true) {
    return { ok: true, alreadyAbandoning: true, record };
  }
  record.abandonRequested = true;
  record.abandonedBy = typeof by === "string" && by !== "" ? by : "/";
  record.abandonReason =
    typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null;
  markRecordDirty(ledger, forkId);
  changed(ledger);
  return { ok: true, alreadyAbandoning: false, record };
}

/**
 * Register one left bracket. Returns the fork record. Nothing blocks, so the
 * parent may register several forks in one beat.
 */
export function registerFork(ledger, spec, options = {}) {
  const { clock = null } = options;
  const s = spec && typeof spec === "object" ? spec : {};
  if (!isNonEmptyString(s.forkId)) {
    return failure("INVALID_FORK_ID", "forkId must be a non-empty string.");
  }
  if (Object.hasOwn(ledger.forks, s.forkId)) {
    return failure("DUPLICATE_FORK", `forkId "${s.forkId}" is already registered.`);
  }
  if (!isNonEmptyString(s.ownerId)) {
    return failure("INVALID_OWNER", "ownerId must be a non-empty string.");
  }
  if (!isNonEmptyString(s.fsm)) {
    return failure("INVALID_FSM", "fsm must be a non-empty string.");
  }
  if (!isDepth(s.depth)) {
    return failure("INVALID_DEPTH", "depth must be a non-negative integer.");
  }
  if (s.budget !== undefined && !validBudget(s.budget)) {
    return failure("INVALID_BUDGET", "The `budget` field must be a plain object of non-negative turns.");
  }
  if (s.time !== undefined && s.time !== null) {
    if (typeof s.time !== "number" || !Number.isFinite(s.time) || s.time <= 0) {
      return failure("INVALID_TIME", "time must be a positive number of seconds.");
    }
  }
  const upscopePath =
    typeof s.upscopePath === "string" && s.upscopePath.startsWith("/")
      ? s.upscopePath
      : "/";
  const scopeId =
    isNonEmptyString(s.scopeId) ? s.scopeId.trim() : s.forkId;
  const path =
    typeof s.path === "string" && s.path.startsWith("/") && s.path !== "/"
      ? s.path
      : subscopePath(upscopePath, scopeId);
  const pathLower = path.toLowerCase();
  for (const existingId of ledger.order ?? []) {
    const existing = forkOf(ledger, existingId);
    if (existing?.path && existing.path.toLowerCase() === pathLower) {
      return failure("DUPLICATE_SCOPE_PATH", `Path "${path}" is already registered.`);
    }
  }
  const upscopeId =
    typeof s.upscopeId === "string" && s.upscopeId !== "" && s.upscopeId !== "root"
      ? s.upscopeId
      : null;
  const callerPath =
    typeof s.callerPath === "string" && s.callerPath.startsWith("/")
      ? s.callerPath
      : "/";
  const levelKey = isNonEmptyString(s.levelKey) ? s.levelKey : "";
  const budget = copyCounts(s.budget ?? {});
  const remaining = copyCounts(budget);
  const spent = {};
  for (const tool of Object.keys(budget)) put(spent, tool, 0);
  const timeBudgetMs = typeof s.time === "number" ? Math.round(s.time * 1000) : null;
  const startedAt = Number.isFinite(s.startedAt) ? s.startedAt : null;
  ledger.seq += 1;
  ledger.dirSeq = (Number.isInteger(ledger.dirSeq) ? ledger.dirSeq : 0) + 1;
  // The injected clock below may throw or synchronously persist before the
  // fork is inserted. The sequence has already advanced in either case, so
  // make that partial change visible to every persistence consumer now.
  markLedgerStructDirty(ledger);
  const targets = Array.isArray(s.targets)
    ? s.targets.map((target) => target)
    : undefined;
  const role = roleOfSegment(scopeId);
  const record = {
    forkId: s.forkId,
    scopeId,
    // The name encodes the role; a bare legacy id has none.
    ...(role ? { role } : {}),
    path,
    upscopeId,
    upscopePath,
    ownerId: s.ownerId,
    callerPath,
    levelKey,
    fsm: s.fsm.trim(),
    profession: typeof s.profession === "string" ? s.profession.trim() : "",
    depth: s.depth,
    childDepth: s.depth + 1,
    ...(targets !== undefined ? { targets } : {}),
    // Return nudges already given. One field, because the station's in-turn
    // steer and the spawn ticket's out-of-turn prompt both spend it.
    returnNudges: 0,
    // Small self-handoff count on this scope (oath `unfinished`).
    handoffCount: 0,
    // Graceful abandon flags.
    abandonRequested: false,
    abandonedBy: null,
    abandonReason: null,
    // Snapshot and model metadata.
    safeSnapshotLeafId:
      typeof s.safeSnapshotLeafId === "string" && s.safeSnapshotLeafId !== ""
        ? s.safeSnapshotLeafId
        : null,
    birthContextTokens:
      typeof s.birthContextTokens === "number" && Number.isFinite(s.birthContextTokens)
        ? s.birthContextTokens
        : null,
    snapshotContextTokens:
      typeof s.snapshotContextTokens === "number" && Number.isFinite(s.snapshotContextTokens)
        ? s.snapshotContextTokens
        : null,
    contextWindow:
      typeof s.contextWindow === "number" && Number.isFinite(s.contextWindow)
        ? s.contextWindow
        : null,
    resolvedModel:
      typeof s.resolvedModel === "string" && s.resolvedModel !== ""
        ? s.resolvedModel
        : null,
    resolvedThinking:
      typeof s.resolvedThinking === "string" && s.resolvedThinking !== ""
        ? s.resolvedThinking
        : null,
    openSeq: ledger.seq,
    closeSeq: null,
    closedOrder: null,
    readySeq: null,
    status: RUNNING,
    outcome: null,
    reason: null,
    reparentedFrom: null,
    // The branch's own account. A fork spec is the only place a branch's budget
    // is born; the parent's budget never funds it and never shrinks for it.
    budget,
    remaining,
    spent,
    timeBudgetMs,
    startedAt,
    deadlineAt: null,
    overtimeAt: null,
    // Waiting for another branch is not this branch's work. A pause freezes
    // the remaining time; resume shifts the deadline by the paused span.
    clockPausedAt: null,
    pausedMs: 0,
  };
  registerRecord(ledger, record);
  if (clock && typeof clock.start === "function") {
    clock.start(record, timeBudgetMs, startedAt);
  }
  put(ledger.forks, s.forkId, record);
  ledger.order.push(s.forkId);
  markRecordDirty(ledger, s.forkId);
  markLedgerStructDirty(ledger);
  return { ok: true, fork: record };
}



function queueFor(ledger, ownerId) {
  if (!Object.hasOwn(ledger.queues, ownerId)) {
    put(ledger.queues, ownerId, []);
    // An empty queue is still part of the ledger's serialized state. Creation
    // may be followed by an early return, without any later structural mark.
    markLedgerStructDirty(ledger);
  }
  return ledger.queues[ownerId];
}

/**
 * Child side closed its bracket. The result joins the owner's ready queue.
 * A failed child still queues: the parent must see the failure, and a silent
 * loss would deadlock the join.
 */


/**
 * Child side closed its bracket. The result joins the owner's ready queue.
 * A failed child still queues: the parent must see the failure, and a silent
 * loss would deadlock the join.
 */
export function markReady(ledger, forkId, outcome = {}) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  if (record.status !== RUNNING) {
    return failure("FORK_NOT_RUNNING", `Fork "${forkId}" is ${record.status}.`);
  }
  ledger.receiveSeq += 1;
  ledger.dirSeq = (Number.isInteger(ledger.dirSeq) ? ledger.dirSeq : 0) + 1;
  record.status = READY;
  record.readySeq = ledger.receiveSeq;
  // Reading the supplied outcome can execute user-defined getters. They may
  // throw or reenter persistence after the state above has already changed.
  // Make that partial transition visible before reading the first getter,
  // without notifying listeners on this previously silent failure path.
  markRecordDirty(ledger, forkId);
  markLedgerStructDirty(ledger);
  record.outcome = outcome?.ok === false ? FAILED : "ok";
  if (outcome?.abandoned === true) {
    record.abandonRequested = true;
    if (typeof outcome.abandonedBy === "string" && outcome.abandonedBy !== "") {
      record.abandonedBy = outcome.abandonedBy;
    }
    if (typeof outcome.abandonReason === "string" && outcome.abandonReason !== "") {
      record.abandonReason = outcome.abandonReason;
    }
  }
  // An earlier getter can itself persist and consume the mark. Mark the
  // outcome before invoking the next externally supplied getter.
  markRecordDirty(ledger, forkId);
  record.reason =
    typeof outcome?.reason === "string" && outcome.reason !== ""
      ? outcome.reason
      : null;
  // The frozen record belongs to the bracket, not to the process. Keeping it
  // here is what lets a reload join a result that was already ready. Mark the
  // reason before reading another potentially reentrant getter.
  markRecordDirty(ledger, forkId);
  if (typeof outcome?.record === "string") record.record = outcome.record;
  const queue = queueFor(ledger, record.ownerId);
  queue.push(forkId);
  // The bracket's own fields moved — status, readySeq, outcome, reason — and at
  // least one of them always does here. A missed mark would make the next
  // shared snapshot reuse the old copy of this record, and a restored child
  // would look running while its result is already queued.
  markRecordDirty(ledger, forkId);
  changed(ledger);
  return { ok: true, fork: record, position: queue.length - 1 };
}

/**
 * Drop a delivered record's body from the ledger.
 *
 * A child's record is read exactly once: the parent renders the join receipt
 * from it. After that take it has no reader — keeping it meant every later
 * ledger baseline re-serialized the whole delivered transcript, so a long
 * session's journal grew with the square of its own history.
 *
 * Only the body goes. `fsm`, `targets`, `budget`, snapshot metadata and the
 * outcome stay for directory display and downstream spy forks.
 */
export function releaseRecordText(ledger, forkId) {
  const record = forkOf(ledger, forkId);
  if (!record || record.status !== JOINED) return false;
  if (typeof record.record !== "string") return false;
  try {
    delete record.record;
  } finally {
    // A partial mutation still has to reach the journal: the next baseline
    // must not carry a body this function was asked to drop.
    markRecordDirty(ledger, forkId);
  }
  return true;
}

/**
 * Parent side takes the earliest ready child. Stale queue entries (already
 * joined, superseded, or moved away by reparenting) are dropped on the way.
 */


/**
 * Parent side takes the earliest ready child. Stale queue entries (already
 * joined, superseded, or moved away by reparenting) are dropped on the way.
 */
export function takeReady(ledger, options = {}) {
  const ownerId = options?.ownerId;
  if (!isNonEmptyString(ownerId)) {
    return failure("INVALID_OWNER", "ownerId must be a non-empty string.");
  }
  const explicitLevel = isNonEmptyString(options.levelKey) ? options.levelKey : null;
  const admit = typeof options.admit === "function" ? options.admit : null;
  const queue = queueFor(ledger, ownerId);
  const blocked = [];
  for (let index = 0; index < queue.length; index += 1) {
    const record = forkOf(ledger, queue[index]);
    if (
      !record ||
      record.status !== READY ||
      record.ownerId !== ownerId
    ) {
      queue.splice(index, 1);
      // This cleanup can be the only change when the remaining candidates are
      // refused. Invalidate the snapshot without adding a listener notification
      // to this previously silent cleanup path.
      markLedgerStructDirty(ledger);
      index -= 1;
      continue;
    }
    if (admit) {
      // Admission is injected and receives the live record. It may change the
      // record before returning or throwing, so make that change visible to
      // persistence even when the candidate is refused. Mark before invoking
      // it as well: the callback may synchronously persist while it runs. Keep
      // the original lookup id; the callback can even change record.forkId.
      const candidateId = queue[index];
      markRecordDirty(ledger, candidateId);
      let verdict;
      try {
        verdict = admit(record);
      } finally {
        markRecordDirty(ledger, candidateId);
      }
      if (verdict && verdict.ok === false) {
        // Keep the candidate in place: it stays ready for a later context,
        // and a smaller sibling behind it may still be deliverable now.
        blocked.push({
          forkId: record.forkId,
          code: verdict.code ?? "NOT_ADMITTED",
          reason: verdict.reason ?? null,
          limit: verdict.limit ?? null,
          projected: verdict.projected ?? null,
          overBy: verdict.overBy ?? null,
        });
        continue;
      }
    }
    queue.splice(index, 1);
    ledger.seq += 1;
    ledger.closedSeq += 1;
    record.status = JOINED;
    record.closeSeq = ledger.seq;
    record.closedOrder = ledger.closedSeq;
    // The fork's own level is the default. A reparented child may close in
    // another level, and the caller states that explicitly.
    const levelKey = explicitLevel ?? record.levelKey;
    if (!Object.hasOwn(ledger.levels, levelKey)) put(ledger.levels, levelKey, []);
    ledger.levels[levelKey].push(record.forkId);
    record.levelKey = levelKey;
    // Status, closeSeq, closedOrder and levelKey all moved.
    markRecordDirty(ledger, record.forkId);
    changed(ledger);
    return { ok: true, fork: record };
  }
  if (blocked.length > 0) {
    return failure(
      "NO_ADMISSIBLE_CHILD",
      "No ready scope can be delivered into this context.",
      { blocked },
    );
  }
  return failure("NO_READY_CHILD", "No forked scope has returned yet.");
}

/**
 * The nearest owner that can still take a result.
 *
 * A branch that returned, joined, failed, or was never started (blocked) can
 * never call `scope_join` again. Work still addressed to it would sit in a
 * queue nobody drains, and the child parked in `scope_return` would wait for
 * a take that can never happen. Follow the current receiver chain one step at
 * a time. An unknown owner is not provably dead (a test or a host may name a
 * receiver this ledger does not carry), so it stays; a cycle has no live
 * taker, so the root is the only safe destination.
 */


/**
 * The nearest owner that can still take a result.
 *
 * A branch that returned, joined, failed, or was never started (blocked) can
 * never call `scope_join` again. Work still addressed to it would sit in a
 * queue nobody drains, and the child parked in `scope_return` would wait for
 * a take that can never happen. Follow the current receiver chain one step at
 * a time. An unknown owner is not provably dead (a test or a host may name a
 * receiver this ledger does not carry), so it stays; a cycle has no live
 * taker, so the root is the only safe destination.
 */
export function liveReceiverOf(ledger, ownerId) {
  if (!isNonEmptyString(ownerId) || ownerId === "root") return "root";
  const seen = new Set();
  let current = ownerId;
  while (current !== "root") {
    if (!isNonEmptyString(current) || seen.has(current)) return "root";
    seen.add(current);
    const record = forkOf(ledger, current);
    if (!record) return current;
    // A record that names itself as receiver can never be taken by anyone.
    if (record.ownerId === current) return "root";
    // Skip scopes that have been abandoned (they are winding down to scope_return).
    if (record.status === RUNNING && record.abandonRequested !== true) return current;
    const next = record.ownerId;
    if (!isNonEmptyString(next)) return "root";
    current = next;
  }
  return "root";
}

/**
 * Move one fork's result to a new receiver. A running record has no queue
 * entry yet; a ready one does, and its entry must follow the owner or the
 * ready queue and the record disagree.
 */


/**
 * Move one fork's result to a new receiver. A running record has no queue
 * entry yet; a ready one does, and its entry must follow the owner or the
 * ready queue and the record disagree.
 */
export function adoptFork(ledger, forkId, toOwnerId) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  if (!isNonEmptyString(toOwnerId)) {
    return failure("INVALID_OWNER", "toOwnerId must be a non-empty string.");
  }
  if (record.ownerId === toOwnerId) return { ok: true, record, adopted: false };
  if (record.status === READY) removeFromQueues(ledger, forkId);
  record.reparentedFrom = record.ownerId;
  record.ownerId = toOwnerId;
  if (record.status === READY) queueFor(ledger, toOwnerId).push(forkId);
  // `reparentedFrom` and `ownerId` are record fields. Without this mark the
  // snapshot cache can answer "that record did not move" for a record whose
  // owner changed, and a reload would queue the result under the old owner —
  // a result nobody drains.
  markRecordDirty(ledger, forkId);
  changed(ledger);
  return { ok: true, record, adopted: true };
}

/**
 * Rebuild the ready queues and point every ready result at a live receiver.
 *
 * A reload marks running children ready, and their stored owner may be a
 * branch that returned or was joined before the process ended. Without this
 * pass those results are restored into a queue no one will ever drain, and
 * the parent's receive count never sees them.
 */


/**
 * Rebuild the ready queues and point every ready result at a live receiver.
 *
 * A reload marks running children ready, and their stored owner may be a
 * branch that returned or was joined before the process ended. Without this
 * pass those results are restored into a queue no one will ever drain, and
 * the parent's receive count never sees them.
 */
export function rehomeReadyResults(ledger) {
  if (!ledger || !isPlainObject(ledger.forks)) return { moved: 0 };
  let moved = 0;
  for (const forkId of ledger.order ?? []) {
    const record = forkOf(ledger, forkId);
    if (!record || record.status !== READY) continue;
    const receiver = liveReceiverOf(ledger, record.ownerId);
    if (receiver === record.ownerId) continue;
    record.reparentedFrom = record.ownerId;
    record.ownerId = receiver;
    moved += 1;
    // Rewriting an owner is a record change. The rebuild below also replaces
    // every queue, which marks the structure; the record mark is what keeps a
    // stale owner out of a shared snapshot when the record is what moved.
    markRecordDirty(ledger, record.forkId);
  }
  ledger.queues = {};
  const ready = (ledger.order ?? [])
    .map((forkId) => forkOf(ledger, forkId))
    .filter((record) => record && record.status === READY)
    .sort((left, right) => (left.readySeq ?? 0) - (right.readySeq ?? 0));
  for (const record of ready) queueFor(ledger, record.ownerId).push(record.forkId);
  changed(ledger);
  return { moved };
}

/**
 * Move one owner's unfinished children to another owner. The dying owner's
 * own ready results keep their place, so a grandparent always sees the parent
 * before the parent's children.
 */


/**
 * Move one owner's unfinished children to another owner. The dying owner's
 * own ready results keep their place, so a grandparent always sees the parent
 * before the parent's children.
 */
export function reparentOrphans(ledger, fromOwnerId, toOwnerId) {
  if (!isNonEmptyString(fromOwnerId)) {
    return failure("INVALID_OWNER", "fromOwnerId must be a non-empty string.");
  }
  if (!isNonEmptyString(toOwnerId)) {
    return failure("INVALID_OWNER", "toOwnerId must be a non-empty string.");
  }
  if (fromOwnerId === toOwnerId) {
    return failure("SAME_OWNER", "A fork cannot be moved under its own owner.");
  }
  // The named receiver may itself have returned by now. Hand the work to the
  // nearest live branch instead of a queue that no join will ever drain.
  const receiverId = liveReceiverOf(ledger, toOwnerId);
  if (receiverId === fromOwnerId) {
    return failure("SAME_OWNER", "A fork cannot be moved under its own owner.");
  }
  let moved = 0;
  for (const forkId of ledger.order) {
    const record = forkOf(ledger, forkId);
    if (!record) continue;
    if (record.ownerId !== fromOwnerId) continue;
    if (record.status !== RUNNING) continue;
    record.reparentedFrom = fromOwnerId;
    record.ownerId = receiverId;
    moved += 1;
    // An orphan whose owner moved is a record change, not only a queue one.
    markRecordDirty(ledger, forkId);
  }
  // Ready results already queued for the dying owner follow the same edge.
  // They append behind the dying owner's own result, so a grandparent always
  // sees the parent before the parent's children.
  const source = queueFor(ledger, fromOwnerId);
  const target = queueFor(ledger, receiverId);
  let transferred = 0;
  const remaining = [];
  for (const forkId of source) {
    const record = forkOf(ledger, forkId);
    if (record && record.status === READY) {
      record.ownerId = receiverId;
      target.push(forkId);
      transferred += 1;
      // The transferred record's owner moved with its queue entry.
      markRecordDirty(ledger, forkId);
      continue;
    }
    remaining.push(forkId);
  }
  ledger.queues[fromOwnerId] = remaining;
  changed(ledger);
  return { ok: true, moved, transferred };
}

/** Drop one fork without a result. Used when a parent is cancelled. */


/** Drop one fork without a result. Used when a parent is cancelled. */
export function abandon(ledger, forkId, reason = null) {
  const record = forkOf(ledger, forkId);
  const decision = decideAbandon({ record });
  if (!decision.ok) {
    return decision.code === "FORK_ALREADY_JOINED"
      ? failure("FORK_ALREADY_JOINED", `Fork "${forkId}" is already joined.`)
      : failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  }
  ledger.seq += 1;
  if (record.status === RUNNING) {
    ledger.dirSeq = (Number.isInteger(ledger.dirSeq) ? ledger.dirSeq : 0) + 1;
  }
  record.status = FAILED;
  record.closeSeq = ledger.seq;
  record.outcome = FAILED;
  record.reason = typeof reason === "string" && reason !== "" ? reason : null;
  removeFromQueues(ledger, forkId);
  // The bracket closes here: status, closeSeq, outcome and reason all moved,
  // so the record-level mark is stated rather than inferred.
  markRecordDirty(ledger, forkId);
  changed(ledger);
  return { ok: true, fork: record };
}

/**
 * Close a whole subtree: every fork under `ownerId` that has not already
 * closed. Leaves close before their parents, so a parent's abandoned record
 * never leaves a child open behind it.
 *
 * Running ids come back to the caller because a ledger close cannot stop a
 * live agent. Only the wiring holds that handle, so the station hands the ids
 * over at its tail; the ledger stays the source of truth either way.
 */


/**
 * Close a whole subtree: every fork under `ownerId` that has not already
 * closed. Leaves close before their parents, so a parent's abandoned record
 * never leaves a child open behind it.
 *
 * Running ids come back to the caller because a ledger close cannot stop a
 * live agent. Only the wiring holds that handle, so the station hands the ids
 * over at its tail; the ledger stays the source of truth either way.
 */
export function abandonDescendants(ledger, ownerId, reason = null) {
  if (!ledger || typeof ledger !== "object") {
    return { abandonedIds: [], runningIds: [], liveIds: [] };
  }
  // Build the owner index once, before closing any record. The traversal order
  // within each owner's children is still registration order; the breadth-first
  // frontier and reverse close order below therefore retain their old semantics.
  // Re-scanning the entire ledger for every descendant made a deep tree
  // quadratic even though each record has only one owner.
  const children = new Map();
  for (const forkId of ledger.order) {
    const record = forkOf(ledger, forkId);
    if (!record) continue;
    let owned = children.get(record.ownerId);
    if (!owned) {
      owned = [];
      children.set(record.ownerId, owned);
    }
    owned.push({ forkId, status: record.status });
  }
  const levels = [];
  const seen = new Set();
  let frontier = [typeof ownerId === "string" && ownerId !== "" ? ownerId : "root"];
  while (frontier.length > 0) {
    const next = [];
    for (const owner of frontier) {
      for (const item of children.get(owner) ?? []) {
        if (seen.has(item.forkId)) continue;
        seen.add(item.forkId);
        levels.push(item);
        next.push(item.forkId);
      }
    }
    frontier = next;
  }
  const abandonedIds = [];
  const runningIds = [];
  // Every descendant whose agent may still exist. A closed record is not a
  // stopped agent: a returned or joined child keeps a live prompt loop that a
  // `scope_abandon` can interrupt. Esc means the whole conversation branch stops,
  // so the caller gets these ids even though their records stay untouched.
  const liveIds = [];
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const { forkId, status } = levels[index];
    if (status === FAILED) continue;
    liveIds.push(forkId);
    if (status === JOINED) continue;
    // RUNNING is actively executing.
    if (status === RUNNING) runningIds.push(forkId);
    const decided = abandon(ledger, forkId, reason);
    if (decided.ok) abandonedIds.push(forkId);
  }
  return { abandonedIds, runningIds, liveIds };
}



function removeFromQueues(ledger, forkId) {
  for (const ownerId of Object.keys(ledger.queues)) {
    const queue = ledger.queues[ownerId];
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index] === forkId) queue.splice(index, 1);
    }
  }
}



export function openChildren(ledger, ownerId) {
  const out = [];
  for (const forkId of ledger.order) {
    const record = forkOf(ledger, forkId);
    if (!record) continue;
    if (record.ownerId !== ownerId || record.status !== RUNNING) continue;
    out.push(forkId);
  }
  return out;
}

/**
 * Work this owner still owes a receive. A running child and a returned child
 * that no join has taken are both unreceived; a blocked plan entry never runs
 * and a joined child is already delivered. The order is the ledger's
 * registration order, so the parent sees the same set every time it reads.
 */


/**
 * Work this owner still owes a receive. A running child and a returned child
 * that no join has taken are both unreceived; a blocked plan entry never runs
 * and a joined child is already delivered. The order is the ledger's
 * registration order, so the parent sees the same set every time it reads.
 */
export function unreceivedChildren(ledger, ownerId) {
  const out = [];
  for (const forkId of ledger.order) {
    const record = forkOf(ledger, forkId);
    if (!record) continue;
    if (record.ownerId !== ownerId) continue;
    if (record.status !== RUNNING && record.status !== READY) continue;
    out.push(forkId);
  }
  return out;
}



export function readyChildren(ledger, ownerId) {
  const out = [];
  for (const forkId of ledger.order) {
    const record = forkOf(ledger, forkId);
    if (!record) continue;
    if (
      record.ownerId !== ownerId ||
      record.status !== READY
    ) {
      continue;
    }
    out.push(forkId);
  }
  out.sort((a, b) => {
    const left = forkOf(ledger, a);
    const right = forkOf(ledger, b);
    return (left?.readySeq ?? 0) - (right?.readySeq ?? 0);
  });
  return out;
}



export function hasOpenChildren(ledger, ownerId) {
  return openChildren(ledger, ownerId).length > 0;
}

/** Fork ids at one level, in right-bracket completion order. */


/** Fork ids at one level, in right-bracket completion order. */
export function levelOrder(ledger, levelKey) {
  const key = typeof levelKey === "string" ? levelKey : "";
  const list = ledger.levels?.[key];
  return Array.isArray(list) ? list.slice() : [];
}

/**
 * Structural self-check. It reports every inconsistency instead of stopping
 * at the first, because a ledger is repaired from a full list.
 */


/**
 * Structural self-check. It reports every inconsistency instead of stopping
 * at the first, because a ledger is repaired from a full list.
 */
export function assertPairing(ledger) {
  return pairingProblems(ledger, null);
}

// Restored ledgers are private, validated plain data. Their queues can be
// indexed once rather than searching the same queue for each ready record.
// Public assertPairing retains its original access order for arbitrary inputs.


// Restored ledgers are private, validated plain data. Their queues can be
// indexed once rather than searching the same queue for each ready record.
// Public assertPairing retains its original access order for arbitrary inputs.
export function pairingProblems(ledger, queueIndex) {
  const problems = [];
  for (const forkId of ledger.order) {
    const record = forkOf(ledger, forkId);
    if (!record) {
      problems.push(`order holds unknown fork "${forkId}"`);
      continue;
    }
    if (!isNonEmptyString(record.ownerId)) {
      problems.push(`fork "${forkId}" has no owner`);
    }
    if (record.childDepth !== record.depth + 1) {
      problems.push(`fork "${forkId}" depth is inconsistent`);
    }
    if (record.status === JOINED) {
      if (!Number.isInteger(record.closeSeq)) {
        problems.push(`joined fork "${forkId}" has no closeSeq`);
      }
      if (!Number.isInteger(record.closedOrder)) {
        problems.push(`joined fork "${forkId}" has no closedOrder`);
      }
    } else if (record.closeSeq !== null && record.status !== FAILED) {
      problems.push(`fork "${forkId}" is ${record.status} but has a closeSeq`);
    }
    if (record.status === READY && !Number.isInteger(record.readySeq)) {
      problems.push(`ready fork "${forkId}" has no readySeq`);
    }
    if (record.status === READY &&
        !(queueIndex
          ? (queueIndex.get(record.ownerId)?.has(forkId) ?? false)
          : (ledger.queues[record.ownerId] ?? []).includes(forkId))) {
      problems.push(`ready fork "${forkId}" is not queued`);
    }
  }
  for (const ownerId of Object.keys(ledger.queues)) {
    const queue = ledger.queues[ownerId];
    const seen = new Set();
    for (const forkId of queue) {
      if (seen.has(forkId)) {
        problems.push(`queue "${ownerId}" holds "${forkId}" twice`);
      }
      seen.add(forkId);
      const record = forkOf(ledger, forkId);
      if (!record) {
        problems.push(`queue "${ownerId}" holds unknown fork "${forkId}"`);
        continue;
      }
      if (record.status !== READY) {
        problems.push(`queue "${ownerId}" holds "${forkId}" in state ${record.status}`);
      }
      if (record.ownerId !== ownerId) {
        problems.push(`queue "${ownerId}" holds "${forkId}" owned by "${record.ownerId}"`);
      }
    }
  }
  for (const levelKey of Object.keys(ledger.levels)) {
    let previous = 0;
    for (const forkId of ledger.levels[levelKey]) {
      const record = forkOf(ledger, forkId);
      if (!record) {
        problems.push(`level "${levelKey}" holds unknown fork "${forkId}"`);
        continue;
      }
      if (record.status !== JOINED) {
        problems.push(`level "${levelKey}" holds "${forkId}" in state ${record.status}`);
      }
      if (!Number.isInteger(record.closedOrder) || record.closedOrder <= previous) {
        problems.push(`level "${levelKey}" order is not increasing at "${forkId}"`);
      } else {
        previous = record.closedOrder;
      }
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}



export function statsOf(ledger) {
  const counts = { running: 0, ready: 0, joined: 0, failed: 0 };
  for (const forkId of ledger.order) {
    const record = forkOf(ledger, forkId);
    if (record && Object.hasOwn(counts, record.status)) counts[record.status] += 1;
  }
  return {
    forks: ledger.order.length,
    ...counts,
    levels: Object.keys(ledger.levels ?? {}).length,
  };
}

// -- Persistence (pure data; no clock, no I/O) ------------------------------
//
// The bracket tree is a domain fact, so it lives in the scope state and is
// restored with it. A process-local Map would make a running child vanish on
// restart and leave an open bracket nobody can close.



// The four status constants are exported individually above.


