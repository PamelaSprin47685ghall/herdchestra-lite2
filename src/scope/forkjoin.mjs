// Fork/join bracket ledger: pairing, reparenting, sibling order, fold gates.
//
// A fork opens a left bracket. A join (parent side) or a return (child side)
// closes a right bracket. Brackets may interleave; every pair must close.
// This module is pure data and arithmetic. It holds no host objects, reads no
// clock, and performs no I/O.

import { decideAbandon } from "./abandon.mjs";
import { deadlineInfo } from "./clock.mjs";
import { emptyTotals, normalizeTotals } from "./turn-stats.mjs";
import { childScopePath } from "./path.mjs";
import { grantBudget } from "./panhandle.mjs";
import { formatAmount } from "./turns.mjs";
import {
  ledgerMeta,
  markLedgerStructDirty,
  markRecordDirty,
  registerLedger,
  registerRecord,
} from "./ledger-cache.mjs";

export { markLedgerStructDirty, markRecordDirty, touchRecord } from "./ledger-cache.mjs";

const listeners = Symbol("ledger listeners");

export function subscribeLedger(ledger, listener) {
  if (!ledger[listeners]) Object.defineProperty(ledger, listeners, { value: new Set() });
  ledger[listeners].add(listener);
}

// Every caller of `changed` has just moved a counter, a queue, a level list,
// or a record. A record-only change may reach here too; the serializer then
// rebuilds the small top-level arrays and still reuses every untouched record.
function changed(ledger) {
  markLedgerStructDirty(ledger);
  for (const listener of ledger[listeners] ?? []) listener();
}

/**
 * Mark one record as changed after a direct field write.
 *
 * The mailbox, the read cursor and the wake flag are written by the send path
 * in place, because they are not fork annotations. A shared snapshot only
 * copies records whose dirty mark is set, so a message that skips this call can
 * be missing from the next snapshot while the ledger still holds it.
 */
export function touchFork(ledger, forkId) {
  if (!forkOf(ledger, forkId)) return false;
  markRecordDirty(ledger, forkId);
  return true;
}

export function annotateFork(ledger, forkId, fields = {}) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  // The record owns its target list: a later amend pushes into it, and that
  // push must not grow the array the caller handed in.
  if (fields.targets !== undefined) {
    record.targets = Array.isArray(fields.targets)
      ? fields.targets.map((target) => target)
      : fields.targets;
    markRecordDirty(ledger, forkId);
  }
  if (fields.model !== undefined) {
    record.model = fields.model;
    markRecordDirty(ledger, forkId);
  }
  // A scope's address and its parent pointer are decided once, when the scope
  // is created, and travel together: the path is derived from the parent's
  // path, so a record with one and not the other cannot be addressed.
  if (fields.path !== undefined) {
    record.path = fields.path;
    markRecordDirty(ledger, forkId);
  }
  if (fields.parentForkId !== undefined) {
    record.parentForkId = fields.parentForkId;
    markRecordDirty(ledger, forkId);
  }
  return { ok: true, record };
}

const RUNNING = "running";
const READY = "ready";
const JOINED = "joined";
const FAILED = "failed";

function failure(code, reason, details) {
  return details && typeof details === "object"
    ? { ok: false, code, reason, ...details }
    : { ok: false, code, reason };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isDepth(value) {
  return Number.isInteger(value) && value >= 0;
}

function put(object, key, value) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function createBracketLedger() {
  const ledger = {
    version: 2,
    // Monotonic event counter shared by fork registration and join
    // completion, so an interval can compare positions from both sides.
    seq: 0,
    // Right-bracket completion counter. This alone defines sibling order.
    closedSeq: 0,
    // Receive counter. It orders the ready queue across reparenting.
    receiveSeq: 0,
    forks: {},
    order: [],
    queues: {},
    levels: {},
    // The root's mailbox. A branch addresses `/`, and the message lands here
    // whether or not a root station is bound in this process.
    rootInbox: [],
    // Session-wide request timing. Shared by reference across scopes, so k
    // concurrent requests add k durations and k turns. Missing on old snapshots.
    totals: emptyTotals(),
  };
  registerLedger(ledger);
  return ledger;
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
  const levelKey = isNonEmptyString(s.levelKey) ? s.levelKey : "";
  const budget = copyCounts(s.budget ?? {});
  const remaining = copyCounts(budget);
  const spent = {};
  for (const tool of Object.keys(budget)) put(spent, tool, 0);
  const timeBudgetMs = typeof s.time === "number" ? Math.round(s.time * 1000) : null;
  const startedAt = Number.isFinite(s.startedAt) ? s.startedAt : null;
  ledger.seq += 1;
  const record = {
    forkId: s.forkId,
    scopeId: s.scopeId,
    ownerId: s.ownerId,
    levelKey,
    fsm: s.fsm.trim(),
    // The identity statement handed to the child at spawn time. A record
    // without one is legal here only because older snapshots predate the
    // field; every tool-created fork validates it before registration.
    profession: typeof s.profession === "string" ? s.profession.trim() : "",
    depth: s.depth,
    childDepth: s.depth + 1,
    // The address, and the sibling it competes with for its name. A child's
    // path is its parent's path plus its own name, so the tree is its own
    // address space.
    parentForkId:
      typeof s.parentForkId === "string" && s.parentForkId !== ""
        ? s.parentForkId
        : s.ownerId === "root"
          ? null
          : s.ownerId,
    path:
      typeof s.path === "string" && s.path !== ""
        ? s.path
        : childScopePath(s.parentPath ?? "/", s.scopeId ?? s.forkId),
    // A mailbox. `inboxDelivered` is how far the branch has read it, so a
    // queued message is never handed twice.
    inbox: [],
    inboxDelivered: 0,
    // True while a finished scope is awake to answer a message. The bracket
    // status itself does not move: the parent's ready or joined record stays
    // the parent's business.
    woken: false,
    // Requirements queued after the birth fsm, and how many the child has
    // been handed. A blocked entry can collect them before it ever runs.
    requirements: [],
    requirementsDelivered: 0,
    // The scope's address. It is decided once, under the parent's path, and
    // the sibling namespace is the only uniqueness rule; `null` on a record
    // written before addresses existed, where the name is the fallback.
    path: isNonEmptyString(s.path) ? s.path : null,
    parentForkId: isNonEmptyString(s.parentForkId) ? s.parentForkId : null,
    // The mailbox. A message is queued here and read at a turn boundary, so a
    // running tool call is never interrupted; `inboxDelivered` is the read
    // cursor, and `woken` marks a finished scope that a message returned to
    // the active list. All three persist with the record.
    inbox: [],
    inboxDelivered: 0,
    woken: false,
    // Return nudges already given. One field, because the station's in-turn
    // steer and the spawn ticket's out-of-turn prompt both spend it.
    returnNudges: 0,
    supersededAt: null,
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
    charges: {},
    timeBudgetMs,
    startedAt,
    deadlineAt: null,
    overtimeAt: null,
    // Waiting for another branch is not this branch's work. A pause freezes
    // the remaining time; resume shifts the deadline by the paused span.
    clockPausedAt: null,
    pausedMs: 0,
  };
  if (clock && typeof clock.start === "function") {
    clock.start(record, timeBudgetMs, startedAt);
  }
  registerRecord(ledger, record);
  put(ledger.forks, s.forkId, record);
  ledger.order.push(s.forkId);
  markLedgerStructDirty(ledger);
  return { ok: true, fork: record };
}

export function forkOf(ledger, forkId) {
  if (!ledger || typeof ledger !== "object") return null;
  if (typeof forkId !== "string" || forkId === "") return null;
  const record = ledger.forks?.[forkId];
  return record && typeof record === "object" ? record : null;
}

function queueFor(ledger, ownerId) {
  if (!Object.hasOwn(ledger.queues, ownerId)) put(ledger.queues, ownerId, []);
  return ledger.queues[ownerId];
}

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
  record.status = READY;
  record.readySeq = ledger.receiveSeq;
  record.outcome = outcome?.ok === false ? FAILED : "ok";
  record.reason =
    typeof outcome?.reason === "string" && outcome.reason !== ""
      ? outcome.reason
      : null;
  // The frozen record belongs to the bracket, not to the process. Keeping it
  // here is what lets a reload join a result that was already ready.
  if (typeof outcome?.record === "string") record.record = outcome.record;
  const queue = queueFor(ledger, record.ownerId);
  queue.push(forkId);
  settleCharges(ledger, record);
  changed(ledger);
  return { ok: true, fork: record, position: queue.length - 1 };
}

/**
 * Put one message on a branch's mailbox. A running branch reads it at its next
 * turn boundary; a finished one is woken to read it, and its bracket status
 * never moves, so the parent's ready or joined record stays the parent's.
 */
export function enqueueScopeMessage(ledger, forkId, message = {}) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  if (!Array.isArray(record.inbox)) record.inbox = [];
  const from = typeof message.from === "string" && message.from !== "" ? message.from : "/";
  const text = typeof message.message === "string" ? message.message.trim() : "";
  const envelope =
    typeof message.envelope === "string" && message.envelope !== ""
      ? message.envelope
      : `[Message from ${from}]\n${text}`;
  record.inbox.push({ from, message: text, envelope });
  const budget = message.budget;
  if (budget && typeof budget === "object" && Object.keys(budget).length > 0) {
    const granted = grantBudget(
      record,
      { tools: budget },
      { allowClockOff: true, scopeCap: true },
    );
    if (!granted.ok) return granted;
  }
  if (record.status !== RUNNING) record.woken = true;
  markRecordDirty(ledger, forkId);
  return { ok: true, record, woken: record.woken === true };
}

/** Hand the branch every message it has not read yet, in order. */
export function takePendingInbox(ledger, forkId) {
  const record = forkOf(ledger, forkId);
  if (!record) return [];
  const inbox = Array.isArray(record.inbox) ? record.inbox : [];
  const cursor = Number.isInteger(record.inboxDelivered) ? record.inboxDelivered : 0;
  if (cursor >= inbox.length) return [];
  const pending = inbox.slice(cursor);
  record.inboxDelivered = inbox.length;
  markRecordDirty(ledger, forkId);
  return pending;
}

/** End a wake: the branch stops answering and leaves the active list again. */
export function finishWokenScope(ledger, forkId) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  record.woken = false;
  markRecordDirty(ledger, forkId);
  changed(ledger);
  return { ok: true, record };
}

/** Put one message in the root's mailbox; the root has no bracket record. */
export function enqueueRootMessage(ledger, message = {}) {
  if (!Array.isArray(ledger.rootInbox)) ledger.rootInbox = [];
  const from = typeof message.from === "string" && message.from !== "" ? message.from : "/";
  const text = typeof message.message === "string" ? message.message.trim() : "";
  const envelope =
    typeof message.envelope === "string" && message.envelope !== ""
      ? message.envelope
      : `[Message from ${from}]\n${text}`;
  const entry = { from, message: text, envelope };
  ledger.rootInbox.push(entry);
  changed(ledger);
  return { ok: true, entry };
}

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
      record.ownerId !== ownerId ||
      record.supersededAt
    ) {
      queue.splice(index, 1);
      index -= 1;
      continue;
    }
    if (admit) {
      const verdict = admit(record);
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
    settleCharges(ledger, record);
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
    if (record.status === RUNNING) return current;
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
  if (record.status === READY && !record.supersededAt) queueFor(ledger, toOwnerId).push(forkId);
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
export function rehomeReadyResults(ledger) {
  if (!ledger || !isPlainObject(ledger.forks)) return { moved: 0 };
  let moved = 0;
  for (const forkId of ledger.order ?? []) {
    const record = forkOf(ledger, forkId);
    if (!record || record.status !== READY || record.supersededAt) continue;
    const receiver = liveReceiverOf(ledger, record.ownerId);
    if (receiver === record.ownerId) continue;
    record.reparentedFrom = record.ownerId;
    record.ownerId = receiver;
    moved += 1;
  }
  ledger.queues = {};
  const ready = (ledger.order ?? [])
    .map((forkId) => forkOf(ledger, forkId))
    .filter((record) => record && record.status === READY && !record.supersededAt)
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
    if (record && record.status === READY && record.supersededAt) continue;
    if (record && record.status === READY) {
      record.ownerId = receiverId;
      target.push(forkId);
      transferred += 1;
      continue;
    }
    remaining.push(forkId);
  }
  ledger.queues[fromOwnerId] = remaining;
  changed(ledger);
  return { ok: true, moved, transferred };
}

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
  record.status = FAILED;
  record.closeSeq = ledger.seq;
  record.outcome = FAILED;
  record.reason = typeof reason === "string" && reason !== "" ? reason : null;
  removeFromQueues(ledger, forkId);
  settleCharges(ledger, record);
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
export function abandonDescendants(ledger, ownerId, reason = null) {
  if (!ledger || typeof ledger !== "object") {
    return { abandonedIds: [], runningIds: [] };
  }
  const levels = [];
  const seen = new Set();
  let frontier = [typeof ownerId === "string" && ownerId !== "" ? ownerId : "root"];
  while (frontier.length > 0) {
    const next = [];
    for (const owner of frontier) {
      for (const forkId of ledger.order) {
        const record = forkOf(ledger, forkId);
        if (!record || record.ownerId !== owner) continue;
        if (seen.has(forkId)) continue;
        seen.add(forkId);
        levels.push({ forkId, status: record.status });
        next.push(forkId);
      }
    }
    frontier = next;
  }
  const abandonedIds = [];
  const runningIds = [];
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const { forkId, status } = levels[index];
    // Already closed: a second cancel is a no-op, and the record keeps the
    // reason its first cancel wrote.
    if (status === FAILED || status === JOINED) continue;
    if (status === RUNNING) runningIds.push(forkId);
    const decided = abandon(ledger, forkId, reason);
    if (decided.ok) abandonedIds.push(forkId);
  }
  return { abandonedIds, runningIds };
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
export function unreceivedChildren(ledger, ownerId) {
  const out = [];
  for (const forkId of ledger.order) {
    const record = forkOf(ledger, forkId);
    if (!record) continue;
    if (record.ownerId !== ownerId) continue;
    if (record.supersededAt) continue;
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
      record.status !== READY ||
      record.supersededAt
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
export function levelOrder(ledger, levelKey) {
  const key = typeof levelKey === "string" ? levelKey : "";
  const list = ledger.levels?.[key];
  return Array.isArray(list) ? list.slice() : [];
}

/**
 * Structural self-check. It reports every inconsistency instead of stopping
 * at the first, because a ledger is repaired from a full list.
 */
export function assertPairing(ledger) {
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
    if (record.status === READY && !record.supersededAt && !(ledger.queues[record.ownerId] ?? []).includes(forkId)) {
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
  const counts = { running: 0, ready: 0, joined: 0, failed: 0, blocked: 0 };
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

const INTERRUPTED_REASON =
  "interrupted by a process restart before the result was received";
const STATUSES = new Set([RUNNING, READY, JOINED, FAILED]);

function copyData(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => copyData(item) ?? null);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      const copy = copyData(value[key]);
      if (copy !== undefined) put(out, key, copy);
    }
    return out;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

function validNumberMap(value) {
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

function validRecord(forkId, record) {
  if (!isPlainObject(record)) return false;
  if (record.forkId !== forkId) return false;
  if (!isNonEmptyString(record.ownerId)) return false;
  if (!isNonEmptyString(record.fsm)) return false;
  if (!isDepth(record.depth)) return false;
  if (!STATUSES.has(record.status)) return false;
  if (!Number.isInteger(record.openSeq) || record.openSeq < 0) return false;
  // The persisted field is named `budget`; its values are turn counts.
  if (!validNumberMap(record.budget)) return false;
  if (!validNumberMap(record.remaining)) return false;
  if (!validNumberMap(record.spent)) return false;
  if (record.record !== null && record.record !== undefined) {
    if (typeof record.record !== "string") return false;
  }
  if (record.reason !== null && record.reason !== undefined) {
    if (typeof record.reason !== "string") return false;
  }
  // Absent is legal: snapshots written before the allowance existed have
  // none, and the readers treat that as zero.
  if (record.returnNudges !== null && record.returnNudges !== undefined) {
    if (!Number.isInteger(record.returnNudges) || record.returnNudges < 0) return false;
  }
  // Address and mailbox: absent in older snapshots, but a present value must
  // be the shape the sender and the resolver both assume.
  if (record.path !== null && record.path !== undefined) {
    if (typeof record.path !== "string" || !record.path.startsWith("/")) return false;
  }
  if (record.parentForkId !== null && record.parentForkId !== undefined) {
    if (typeof record.parentForkId !== "string") return false;
  }
  if (record.woken !== undefined && typeof record.woken !== "boolean") return false;
  if (record.inboxDelivered !== undefined) {
    if (!Number.isInteger(record.inboxDelivered) || record.inboxDelivered < 0) return false;
  }
  if (record.inbox !== undefined) {
    if (!Array.isArray(record.inbox)) return false;
    for (const entry of record.inbox) {
      if (!isPlainObject(entry)) return false;
      if (typeof entry.envelope !== "string") return false;
      if (typeof entry.from !== "string") return false;
    }
  }
  return true;
}

/** True when a stored value can rebuild a bracket tree without guessing. */
export function validLedger(value) {
  if (!isPlainObject(value)) return false;
  if (value.version !== 2) return false;
  for (const key of ["seq", "closedSeq", "receiveSeq"]) {
    if (!Number.isInteger(value[key]) || value[key] < 0) return false;
  }
  if (!isPlainObject(value.forks)) return false;
  if (!Array.isArray(value.order)) return false;
  const seen = new Set();
  for (const forkId of value.order) {
    if (!isNonEmptyString(forkId) || seen.has(forkId)) return false;
    seen.add(forkId);
    if (!Object.hasOwn(value.forks, forkId)) return false;
    if (!validRecord(forkId, value.forks[forkId])) return false;
  }
  for (const key of Object.keys(value.forks)) {
    // A record outside the order cannot be paired or joined; refuse the
    // snapshot instead of restoring a half-addressable tree.
    if (!seen.has(key)) return false;
  }
  if (value.levels !== undefined && !isPlainObject(value.levels)) return false;
  if (value.totals !== undefined && value.totals !== null) {
    if (!isPlainObject(value.totals)) return false;
    const turnMs = value.totals.turnMs;
    const turns = value.totals.turns;
    if (turnMs !== undefined && (!Number.isFinite(turnMs) || turnMs < 0)) return false;
    if (turns !== undefined && (!Number.isFinite(turns) || turns < 0)) return false;
  }
  return true;
}

/** A JSON-safe copy of the tree, safe to persist with the scope state. */
export function serializeLedger(ledger) {
  if (!validLedger(ledger)) return copyData(createBracketLedger());
  return copyData(ledger);
}

/**
 * True when every scalar field of the last copy still holds the live value.
 *
 * Container fields are skipped: the copy holds its own containers, so their
 * identity never matches, and a container mutation is caught by the dirty mark
 * the charge, the panhandle, and the amend leave behind.
 */
function settledFields(copy, record) {
  for (const key of Object.keys(record)) {
    const value = record[key];
    // The copy drops undefined fields; their absence is not a change.
    if (value === undefined) continue;
    const previous = copy[key];
    if (value !== null && typeof value === "object") {
      // A container that appeared after the copy must force a new copy. An
      // unchanged container never matches by identity, so its contents are
      // covered by the dirty mark its mutator leaves behind.
      if (!Object.hasOwn(copy, key)) return false;
      continue;
    }
    if (previous !== value) return false;
  }
  return true;
}

/**
 * A JSON-safe copy of the tree that reuses the previous copy of every record
 * that did not move.
 *
 * A caller that mutates the result must use `serializeLedger`: the returned
 * snapshot is shared with the previous one and with the cache, so a write
 * through it would rewrite history. A caller that only reads and persists may
 * use this one, and gets the same object back while nothing has changed.
 */
export function serializeLedgerShared(ledger) {
  const meta = ledgerMeta(ledger);
  // Nothing moved since the last snapshot: hand back the same tree. This is
  // the steady state, and it allocates nothing.
  if (meta && meta.snapshot && !meta.structDirty && meta.dirtyForks.size === 0) {
    return meta.snapshot;
  }
  if (!validLedger(ledger)) return copyData(createBracketLedger());
  if (!meta) return copyData(ledger);
  const previous = meta.snapshot;
  const forks = {};
  const live = new Set();
  for (const forkId of Object.keys(ledger.forks)) {
    const record = ledger.forks[forkId];
    live.add(forkId);
    const kept =
      !meta.dirtyForks.has(forkId) &&
      previous?.forks !== undefined &&
      Object.hasOwn(previous.forks, forkId) &&
      meta.forkRefs.get(forkId) === record &&
      settledFields(previous.forks[forkId], record)
        ? previous.forks[forkId]
        : null;
    if (kept) {
      put(forks, forkId, kept);
      continue;
    }
    put(forks, forkId, copyData(record));
    meta.forkRefs.set(forkId, record);
  }
  // A fork that left the ledger keeps no copy and no reference.
  for (const forkId of Array.from(meta.forkRefs.keys())) {
    if (!live.has(forkId)) meta.forkRefs.delete(forkId);
  }
  const next = {
    version: ledger.version,
    seq: ledger.seq,
    closedSeq: ledger.closedSeq,
    receiveSeq: ledger.receiveSeq,
    forks,
    order: copyData(ledger.order),
    queues: copyData(ledger.queues),
    levels: copyData(ledger.levels),
    // The root's mailbox is ledger state like any other: a message addressed
    // to `/` must survive the same snapshot a record does, or a reload drops
    // it while `serializeLedger` still reports it.
    rootInbox: copyData(ledger.rootInbox ?? []),
    totals: copyData(ledger.totals),
  };
  meta.snapshot = next;
  meta.structDirty = false;
  meta.dirtyForks.clear();
  return next;
}

/**
 * Rebuild a ledger from a stored snapshot.
 *
 * A running child cannot survive the process. It comes back as a failed ready
 * result: the parent can take it, read why it is empty, and decide whether to
 * re-declare the work. Ready results keep their frozen record and order.
 */
export function restoreLedgerChecked(value) {
  const out = createBracketLedger();
  if (!validLedger(value)) return { ok: false, ledger: out };
  out.seq = value.seq;
  out.closedSeq = value.closedSeq;
  out.receiveSeq = value.receiveSeq;
  out.totals = normalizeTotals(value.totals);
  for (const forkId of value.order) {
    put(out.forks, forkId, copyData(value.forks[forkId]));
    out.order.push(forkId);
  }
  const storedLevels = isPlainObject(value.levels) ? copyData(value.levels) : {};
  for (const key of Object.keys(storedLevels)) {
    const list = Array.isArray(storedLevels[key])
      ? storedLevels[key].filter((forkId) => forkOf(out, forkId)?.status === JOINED)
      : [];
    if (list.length > 0) put(out.levels, key, list);
  }
  for (const forkId of out.order) {
    const record = out.forks[forkId];
    if (record.status !== RUNNING) continue;
    out.receiveSeq += 1;
    record.status = READY;
    record.readySeq = out.receiveSeq;
    record.outcome = FAILED;
    record.reason = INTERRUPTED_REASON;
    record.closeSeq = null;
    record.closedOrder = null;
  }
  const ready = out.order
    .map((forkId) => out.forks[forkId])
    .filter((record) => record.status === READY && !record.supersededAt)
    .sort((left, right) => (left.readySeq ?? 0) - (right.readySeq ?? 0));
  for (const record of ready) {
    if (!Number.isInteger(record.readySeq) || record.readySeq <= 0) {
      out.receiveSeq += 1;
      record.readySeq = out.receiveSeq;
    } else if (record.readySeq > out.receiveSeq) {
      out.receiveSeq = record.readySeq;
    }
  }
  // A stored owner may have returned before the process ended. Point those
  // results at the nearest live receiver and rebuild the queues in one pass.
  rehomeReadyResults(out);
  // A tree that cannot be addressed consistently is not a partial tree: a
  // queue entry without a fork, or a joined level entry out of order, makes
  // every later take guess. Refuse the snapshot as a whole, exactly as a
  // malformed value is refused, so the session starts from a clean ledger.
  if (!assertPairing(out).ok) return { ok: false, ledger: createBracketLedger() };
  // The restored records are the live ones from now on; the clock and the
  // panhandle reach the snapshot cache through them.
  for (const forkId of out.order) registerRecord(out, out.forks[forkId]);
  return { ok: true, ledger: out };
}

/**
 * Rebuild a ledger, discarding the tree when its queues and levels do not
 * pair.
 */
export function restoreLedger(value) {
  return restoreLedgerChecked(value).ledger;
}

export {
  RUNNING,
  READY,
  JOINED,
  FAILED,
};

// -- Branch account (pure arithmetic; no clock, no I/O) --------------------

function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validBudget(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "") return false;
    const amount = value[key];
    if (!Number.isInteger(amount) || amount < 0) return false;
  }
  return true;
}

function copyCounts(source) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key === "string") put(out, key, source[key]);
  }
  return out;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function formatClock(ms) {
  // Remaining time floors: ceil made 57.1s render as 0:58, so the first frame
  // showed remaining equal to the budget granted and looked like a stopped clock.
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// A running branch keeps the per-call receipts an amend can still reach. An
// amend walks back one beat at a time, so the newest groups are the only ones
// worth keeping, and an older group is evicted instead of living until the
// scope ends.
const MAX_CHARGE_GROUPS = 16;
const MAX_UNGROUPED_CHARGES = 32;

/**
 * Drop the charge map of a branch that can no longer be amended.
 *
 * A refund names a tool call of a branch that is still running: an amend only
 * walks back one beat of the executing scope, and a closed bracket refuses
 * every later call. `spent` and `remaining` stay authoritative, so the budget
 * line is unchanged; only the receipt trail goes away.
 */
function settleCharges(ledger, record) {
  if (!isPlainObject(record.charges)) return;
  record.charges = {};
  // `settledFields` compares scalar fields only, so an emptied map is invisible
  // to the snapshot cache. The mark forces the next snapshot to take a copy.
  markRecordDirty(ledger, record.forkId);
}

/** Keep a running branch's receipt trail at one amend window, not at its history. */
function boundCharges(record) {
  const charges = record.charges;
  if (!isPlainObject(charges)) return;
  const groups = [];
  const members = new Map();
  const ungrouped = [];
  for (const key of Object.keys(charges)) {
    const entry = charges[key];
    if (!isPlainObject(entry)) {
      delete charges[key];
      continue;
    }
    if (typeof entry.groupKey === "string") {
      if (!members.has(entry.groupKey)) {
        members.set(entry.groupKey, []);
        groups.push(entry.groupKey);
      }
      members.get(entry.groupKey).push(key);
    } else {
      ungrouped.push(key);
    }
  }
  const staleGroups = groups.slice(0, Math.max(0, groups.length - MAX_CHARGE_GROUPS));
  for (const group of staleGroups) {
    for (const key of members.get(group)) delete charges[key];
  }
  const staleCalls = ungrouped.slice(0, Math.max(0, ungrouped.length - MAX_UNGROUPED_CHARGES));
  for (const key of staleCalls) delete charges[key];
}

function accountOf(record) {
  return {
    remaining: copyCounts(record.remaining),
    spent: copyCounts(record.spent),
  };
}

/**
 * Charge one tool call against a branch. A tool call is charged once: the
 * same toolCallId, or the same beat group for the same tool, answers the
 * existing charge instead of spending twice. A share larger than the turns left
 * spends what is left, so the rest of the beat still runs.
 */
export function applyCharge(ledger, forkId, charge = {}) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  if (!isPlainObject(record.remaining)) record.remaining = copyCounts(record.budget);
  if (!isPlainObject(record.spent)) record.spent = {};
  if (!isPlainObject(record.charges)) record.charges = {};
  const toolCallId = typeof charge.toolCallId === "string" ? charge.toolCallId : "";
  const tool = typeof charge.tool === "string" ? charge.tool : "";
  if (tool === "") {
    return failure("INVALID_TOOL", "A charge must name the tool it spends.");
  }
  const groupKey =
    typeof charge.groupKey === "string" && charge.groupKey !== "" ? charge.groupKey : null;
  if (toolCallId !== "" && Object.hasOwn(record.charges, toolCallId)) {
    return { ok: true, alreadyCharged: true, amount: 0, ...accountOf(record) };
  }
  if (groupKey !== null) {
    for (const key of Object.keys(record.charges)) {
      const existing = record.charges[key];
      if (existing && existing.tool === tool && existing.groupKey === groupKey) {
        return { ok: true, alreadyCharged: true, amount: 0, ...accountOf(record) };
      }
    }
  }
  const remaining = Object.hasOwn(record.remaining, tool) ? record.remaining[tool] : 0;
  const budget = Object.hasOwn(record.budget ?? {}, tool) ? record.budget[tool] : 0;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    const left = Number.isFinite(remaining) ? remaining : 0;
    // The host shows `reason` verbatim when a gate refuses a tool. A refusal
    // without one reads as an unattributed extension block, so the budget
    // itself is stated here.
    return {
      ok: false,
      code: "BUDGET_EXHAUSTED",
      reason: `Tool "${tool}" has no budget left on this branch (remaining ${formatAmount(left)}/${formatAmount(budget)}).`,
      tool,
      remaining: left,
      budget,
    };
  }
  const requested =
    Number.isFinite(charge.amount) && charge.amount > 0 ? charge.amount : 1;
  const amount = round2(Math.min(requested, remaining));
  put(record.remaining, tool, round2(remaining - amount));
  put(record.spent, tool, round2((record.spent[tool] ?? 0) + amount));
  if (toolCallId !== "") {
    const entry = { tool, amount };
    if (groupKey !== null) entry.groupKey = groupKey;
    put(record.charges, toolCallId, entry);
    boundCharges(record);
  }
  markRecordDirty(ledger, forkId);
  return { ok: true, amount, ...accountOf(record) };
}

/** Give back what one amended tool call spent. Repeating it changes nothing. */
export function applyRefund(ledger, forkId, toolCallId) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  if (!isPlainObject(record.charges)) record.charges = {};
  if (!isPlainObject(record.remaining)) record.remaining = copyCounts(record.budget);
  if (!isPlainObject(record.spent)) record.spent = {};
  const charge = typeof toolCallId === "string" ? record.charges[toolCallId] : null;
  if (!charge) return { ok: true, refunded: 0, ...accountOf(record) };
  const tool = charge.tool;
  const amount = Number.isFinite(charge.amount) && charge.amount > 0 ? charge.amount : 0;
  const spent = record.spent[tool] ?? 0;
  const refund = Math.min(amount, spent);
  put(record.spent, tool, round2(Math.max(0, spent - refund)));
  put(record.remaining, tool, round2((record.remaining[tool] ?? 0) + refund));
  delete record.charges[toolCallId];
  markRecordDirty(ledger, forkId);
  return { ok: true, refunded: refund, ...accountOf(record) };
}

/** Render a branch's turns and clock the way the old scope line did. */
export function forkBudgetText(record, now = Date.now(), clock = null) {
  if (!record || !isPlainObject(record.remaining)) return "";
  const entries = [];
  for (const tool of Object.keys(record.remaining).sort()) {
    const budget = record.budget?.[tool];
    if (budget === undefined) continue;
    entries.push(`${tool} remaining ${formatAmount(record.remaining[tool])}/${formatAmount(budget)}`);
  }
  const info = clock && typeof clock.info === "function"
    ? clock.info(record, now)
    : deadlineInfo(record, now);
  const parts = [entries.join(", ")];
  if (info.bounded) {
    parts.push(
      info.overtime
        ? "time OVERTIME"
        : `time remaining ${formatClock(info.leftMs)}/${formatClock(record.timeBudgetMs)}`,
    );
  }
  const panhandled = Number.isInteger(record.panhandleTotal)
    ? record.panhandleTotal
    : Array.isArray(record.panhandles)
      ? record.panhandles.length
      : 0;
  if (panhandled > 0) parts.push(`panhandled ${panhandled}x`);
  return parts.filter((part) => part !== "").join(", ");
}
