// Fork/join bracket ledger: pairing, reparenting, sibling order, fold gates.
//
// A fork opens a left bracket. A join (parent side) or a return (child side)
// closes a right bracket. Brackets may interleave; every pair must close.
// This module is pure data and arithmetic. It holds no host objects, reads no
// clock, and performs no I/O.

import { decideAbandon } from "./abandon.mjs";
import {
  adoptInbox,
  createAppendOnlyInbox,
  inboxVersion,
  isAppendOnlyInbox,
  markSharedPrefix,
} from "./append-only-inbox.mjs";
import { deadlineInfo } from "./clock.mjs";
import { emptyTotals, normalizeTotals } from "./turn-stats.mjs";
import { childScopePath } from "./path.mjs";
import { grantBudget } from "./panhandle.mjs";
import { formatAmount } from "./turns.mjs";
import {
  ledgerMeta,
  markLedgerStructDirty,
  markRecordDirty,
  noteSnapshotStep,
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
    // whether or not a root station is bound in this process. It is closed to
    // everything but appending, which is what lets a snapshot reuse the copies
    // it already stored instead of re-reading them every frame.
    rootInbox: createAppendOnlyInbox(),
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
  // The injected clock below may throw or synchronously persist before the
  // fork is inserted. The sequence has already advanced in either case, so
  // make that partial change visible to every persistence consumer now.
  markLedgerStructDirty(ledger);
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
  registerRecord(ledger, record);
  if (clock && typeof clock.start === "function") {
    clock.start(record, timeBudgetMs, startedAt);
  }
  put(ledger.forks, s.forkId, record);
  ledger.order.push(s.forkId);
  // Registration creates a record as well as changing the ledger structure.
  // Persistence consumers need the new id even when another consumer has
  // already committed its own independent baseline.
  markRecordDirty(ledger, s.forkId);
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
export function markReady(ledger, forkId, outcome = {}) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  if (record.status !== RUNNING) {
    return failure("FORK_NOT_RUNNING", `Fork "${forkId}" is ${record.status}.`);
  }
  ledger.receiveSeq += 1;
  record.status = READY;
  record.readySeq = ledger.receiveSeq;
  // Reading the supplied outcome can execute user-defined getters. They may
  // throw or reenter persistence after the state above has already changed.
  // Make that partial transition visible before reading the first getter,
  // without notifying listeners on this previously silent failure path.
  markRecordDirty(ledger, forkId);
  markLedgerStructDirty(ledger);
  record.outcome = outcome?.ok === false ? FAILED : "ok";
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
  settleCharges(ledger, record);
  // The bracket's own fields moved — status, readySeq, outcome, reason — and at
  // least one of them always does here. Saying so is not redundant with
  // `settleCharges`: that helper returns early when the record has no charges
  // map, which is exactly the shape a restored record can have. A missed mark
  // would make the next shared snapshot reuse the old copy of this record, and
  // a restored child would look running while its result is already queued.
  markRecordDirty(ledger, forkId);
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
  if (!Array.isArray(record.inbox)) {
    record.inbox = [];
    // Reading the message below may invoke a caller-provided getter. If that
    // getter throws or reenters persistence, initialization has already
    // happened and must not be lost from the next snapshot.
    markRecordDirty(ledger, forkId);
  }
  const from = typeof message.from === "string" && message.from !== "" ? message.from : "/";
  const text = typeof message.message === "string" ? message.message.trim() : "";
  const envelope =
    typeof message.envelope === "string" && message.envelope !== ""
      ? message.envelope
      : `[Message from ${from}]\n${text}`;
  record.inbox.push({ from, message: text, envelope });
  // Delivery is already visible even if reading or validating the optional
  // budget throws. Mark before that work so an intervening persistence pass
  // does not reuse a snapshot from before the partial delivery.
  markRecordDirty(ledger, forkId);
  const budget = message.budget;
  if (budget && typeof budget === "object" && Object.keys(budget).length > 0) {
    const granted = grantBudget(
      record,
      { tools: budget },
      { allowClockOff: true, scopeCap: true },
    );
    if (!granted.ok) {
      // The message is already queued even when the budget grant is refused.
      // Preserve that existing partial-delivery behavior in the next snapshot.
      markRecordDirty(ledger, forkId);
      return granted;
    }
  }
  if (record.status !== RUNNING) record.woken = true;
  markRecordDirty(ledger, forkId);
  return { ok: true, record, woken: record.woken === true };
}

/**
 * Drop a delivered record's body from the ledger.
 *
 * A child's record is read exactly once: the parent renders the join receipt
 * from it. After that take it has no reader — a woken scope answers by
 * `scope_send`, and the return contract is `dafny`, not a second copy of the
 * body. Keeping it meant every later ledger baseline re-serialized the whole
 * delivered transcript, so a long session's journal grew with the square of
 * its own history. Releasing it here is what keeps a baseline proportional to
 * the work still in flight.
 *
 * Only the body goes. `fsm`, `targets`, `budget`, `inbox`, `woken` and the
 * outcome stay: they are what a wake and a restart still read.
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

/**
 * Clear the wake flag without publishing a ledger event. The idle wake ticket
 * uses this after its prompt finishes, including its failure path; notification
 * and error handling remain the ticket's responsibility.
 */
export function clearWakeFlag(ledger, forkId, onlyIfWoken = false) {
  const record = forkOf(ledger, forkId);
  if (!record || (onlyIfWoken && record.woken !== true)) return false;
  try {
    record.woken = false;
  } finally {
    // A setter may partially mutate and then throw; the prior mutation door
    // marked even on that path and allowed the exception to propagate.
    markRecordDirty(ledger, forkId);
  }
  return true;
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

/** Append an already prepared root envelope without notifying listeners. */
export function appendRootEnvelope(ledger, entry) {
  // Read the field once. A ledger rebuilt by hand (a legacy snapshot, a caller
  // assembling its own object) gets the real mailbox here, so every later
  // append is closed and no entry already in it is trusted.
  const current = ledger.rootInbox;
  if (!isAppendOnlyInbox(current)) {
    ledger.rootInbox = mailboxFrom(current);
    // Initialization remains visible even if a subsequent push throws.
    markLedgerStructDirty(ledger);
  }
  ledger.rootInbox.push(entry);
  markLedgerStructDirty(ledger);
}

/** Put one message in the root's mailbox; the root has no bracket record. */
export function enqueueRootMessage(ledger, message = {}) {
  const current = ledger.rootInbox;
  if (!isAppendOnlyInbox(current)) {
    ledger.rootInbox = mailboxFrom(current);
    // A message getter can throw or persist synchronously after this mutation.
    // Mark the initialized container without adding a listener notification.
    markLedgerStructDirty(ledger);
  }
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
    settleCharges(ledger, record);
    // Status, closeSeq, closedOrder and levelKey all moved. `settleCharges`
    // does not cover them: it answers only when the record carries a charges
    // map, and a restore can hand back one that does not.
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
    // Rewriting an owner is a record change. The rebuild below also replaces
    // every queue, which marks the structure; the record mark is what keeps a
    // stale owner out of a shared snapshot when the record is what moved.
    markRecordDirty(ledger, record.forkId);
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
    if (record && record.status === READY && record.supersededAt) continue;
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
  // The bracket closes here: status, closeSeq, outcome and reason all moved.
  // `settleCharges` may return without marking (no charges map on a restored
  // record), so the record-level mark is stated rather than inferred.
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
export function abandonDescendants(ledger, ownerId, reason = null) {
  if (!ledger || typeof ledger !== "object") {
    return { abandonedIds: [], runningIds: [] };
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
  return pairingProblems(ledger, null);
}

// Restored ledgers are private, validated plain data. Their queues can be
// indexed once rather than searching the same queue for each ready record.
// Public assertPairing retains its original access order for arbitrary inputs.
function pairingProblems(ledger, queueIndex) {
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
    if (record.status === READY && !record.supersededAt &&
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

// A mailbox entry is `{ from, message, envelope }` — scalars only. Copying it
// with `copyData` allocates nothing for the strings but still walks every entry
// of the mailbox, and a long session holds a million of them: the walk, not the
// bytes, is what a snapshot pays per frame. Freezing the field values is all the
// comparison needs, so a flat entry gets a field-by-field copy and any entry
// that carries a nested object keeps the deep copy it needs.
function flatEntryCopy(entry) {
  if (!isPlainObject(entry)) return null;
  const out = {};
  for (const key of Object.keys(entry)) {
    const value = entry[key];
    if (value === undefined) continue;
    const kind = typeof value;
    if (value !== null && kind !== "string" && kind !== "number" && kind !== "boolean") {
      // Two reasons to take the deep path. A container needs the recursive
      // copy. Anything else — a function, a symbol, a bigint — is not JSON
      // data, and `copyData` drops the field instead of keeping it: a kept
      // bigint would make the snapshot throw on `JSON.stringify`.
      return null;
    }
    // `put` writes an own property, so a key named `__proto__` stays data.
    put(out, key, value);
  }
  return out;
}

function copyInbox(entries) {
  if (!Array.isArray(entries)) return copyData(entries);
  const out = new Array(entries.length);
  for (let index = 0; index < entries.length; index += 1) {
    out[index] = copyInboxEntry(entries[index]);
  }
  return out;
}

function copyInboxEntry(entry) {
  return flatEntryCopy(entry) ?? copyData(entry) ?? null;
}

/**
 * Adopt an outside array as the root mailbox.
 *
 * A ledger can arrive from a legacy snapshot or be assembled by hand, and its
 * mailbox then is a plain array whose entries nobody promised are stable. It is
 * copied into a closed mailbox once, here, so that every append after this point
 * is governed by the same boundary and the snapshot never has to read a prefix
 * it did not itself freeze.
 */
function mailboxFrom(value) {
  return adoptInbox(value);
}

/**
 * The mailbox as the next snapshot holds it.
 *
 * A snapshot that repeated the whole copy paid the session's length on every
 * frame, and the root's mailbox is where a long root-level conversation lives.
 * The mailbox has one write surface and it only appends, so a live array that
 * is still the array the previous snapshot was taken from shares that
 * snapshot's copies for its prefix and copies only the tail. That makes the
 * per-frame cost one pointer copy plus the entries that are actually new.
 *
 * Ownership boundary: this reuses a copy instead of re-reading an entry, so an
 * in-place write to an entry that has already been snapshotted is not observed.
 * No production caller writes one (`appendRootEnvelope` and `enqueueRootMessage`
 * only push, replay writes into a fresh ledger), and the array itself may still
 * be replaced wholesale — that path copies everything and sees a reorder or an
 * empty list exactly as before. A future caller that needs to edit a delivered
 * message must push a new entry, or replace the array.
 */
/**
 * Does this live entry still hold what the stored copy holds?
 *
 * The comparison is deliberately narrow: scalars compare by value, `undefined`
 * counts as absent because the copy drops it, and any container answers `false`.
 * `false` is the safe answer — it sends the caller to the content comparison,
 * which is slower and always right. It is used only for a mailbox that is not
 * ours: a plain array handed in from outside, whose entries nobody promised are
 * stable.
 */
function entryMatchesCopy(entry, copy) {
  if (entry === copy) return true;
  if (!isPlainObject(entry) || !isPlainObject(copy)) return false;
  let count = 0;
  for (const key of Object.keys(entry)) {
    const value = entry[key];
    if (value === undefined) continue;
    count += 1;
    if (value !== null && typeof value === "object") return false;
    if (!Object.hasOwn(copy, key)) return false;
    const stored = copy[key];
    if (stored === value) continue;
    if (
      typeof value === "number" &&
      typeof stored === "number" &&
      !Number.isFinite(value) &&
      !Number.isFinite(stored)
    ) {
      continue;
    }
    return false;
  }
  return count === Object.keys(copy).length;
}

/**
 * True when `liveInbox` holds exactly the stored copies, in the stored order.
 *
 * This is the answer for an untrusted array, and it reads every stored entry.
 * A mailbox that is one of ours never needs it: it cannot be reordered or
 * edited, so its version says all of this in one comparison.
 */
function storedPrefixIntact(liveInbox, previousInbox) {
  const limit = Math.min(liveInbox.length, previousInbox.length);
  for (let index = 0; index < limit; index += 1) {
    if (liveInbox[index] === previousInbox[index]) continue;
    if (!entryMatchesCopy(liveInbox[index], previousInbox[index])) return false;
  }
  return true;
}

const INBOX_SAME = 0;
const INBOX_APPENDED = 1;
const INBOX_REWRITTEN = 2;

/**
 * How the live mailbox relates to the copies the last snapshot stored.
 *
 * A mailbox of ours cannot be reordered, shortened or edited: the object
 * refuses those writes where they happen, and every stored entry is frozen. Its
 * append counter therefore answers the whole question in one comparison — the
 * boundary is in the object, not in this function.
 *
 * Any other array is untrusted, and untrusted means read: a reorder, a splice or
 * an edit must still be seen, so it is compared entry by entry and, when it
 * differs, copied whole. The cost is paid only by a ledger nobody built through
 * the append path.
 */
function inboxRelation(liveInbox, previousInbox, previousVersion) {
  if (isAppendOnlyInbox(liveInbox)) {
    if (liveInbox.length < previousInbox.length) return INBOX_REWRITTEN;
    const appended = inboxVersion(liveInbox) - previousVersion;
    if (appended === 0) return INBOX_SAME;
    if (appended > 0 && liveInbox.length - previousInbox.length === appended) {
      return INBOX_APPENDED;
    }
    // The counter and the length disagree: the mailbox was replaced by another
    // of ours, or entries were appended behind the snapshot's back. Read it.
    return storedPrefixIntact(liveInbox, previousInbox) ? INBOX_APPENDED : INBOX_REWRITTEN;
  }
  if (liveInbox.length < previousInbox.length) return INBOX_REWRITTEN;
  if (!storedPrefixIntact(liveInbox, previousInbox)) return INBOX_REWRITTEN;
  return liveInbox.length === previousInbox.length ? INBOX_SAME : INBOX_APPENDED;
}

function inboxForSnapshot(meta, previous, liveInbox) {
  const previousInbox = Array.isArray(previous?.rootInbox) ? previous.rootInbox : null;
  const held = previousInbox !== null && meta.inboxRef === liveInbox;
  const relation =
    held && isAppendOnlyInbox(liveInbox)
      ? inboxRelation(liveInbox, previousInbox, meta.inboxVersion ?? 0)
      : null;
  meta.inboxRef = liveInbox;
  meta.inboxVersion = isAppendOnlyInbox(liveInbox) ? inboxVersion(liveInbox) : 0;
  if (!held) return copyInbox(liveInbox);
  const decided = relation ?? inboxRelation(liveInbox, previousInbox, 0);
  if (decided === INBOX_REWRITTEN) return copyInbox(liveInbox);
  if (decided === INBOX_SAME) return markSharedPrefix(previousInbox, previousInbox.length, previousInbox);
  // Only the tail is new: an append cannot have moved what the last snapshot
  // stored, and the object it came from cannot be edited or reordered. That is
  // the proof the journal needs to skip its own prefix walk, so carry it — with
  // the array it was proven against, not just a length.
  const out = markSharedPrefix(previousInbox.slice(), previousInbox.length, previousInbox);
  for (let index = previousInbox.length; index < liveInbox.length; index += 1) {
    out.push(copyInboxEntry(liveInbox[index]));
  }
  return out;
}

/**
 * Does a live record still equal the JSON-safe copy a snapshot stored?
 *
 * The previous form copied the record and serialized both sides, so one frame
 * allocated two complete strings of the session's largest record and threw them
 * away. This walks the live value against the stored one instead: no copy, no
 * string, one traversal. It answers exactly what `JSON.stringify(copyData(live))
 * === JSON.stringify(stored)` answered, including the cases that make that
 * question awkward — a value `copyData` would drop counts as absent, an array
 * hole counts as null, and two non-finite numbers are equal because JSON writes
 * both as null.
 */
function sameStoredValue(live, stored) {
  if (live === stored) return true;
  if (live === undefined) return false;
  if (Array.isArray(live)) {
    if (!Array.isArray(stored) || stored.length !== live.length) return false;
    for (let index = 0; index < live.length; index += 1) {
      const child = live[index];
      // `copyData` writes `copyData(item) ?? null`: an absent element and any
      // value JSON cannot hold both become null, so an array of mixed content
      // still compares equal to its stored copy instead of churning the record.
      const wanted = isJsonValue(child) ? child : null;
      if (!sameStoredValue(wanted, stored[index])) return false;
    }
    return true;
  }
  if (isPlainObject(live)) {
    if (!isPlainObject(stored)) return false;
    let count = 0;
    for (const key of Object.keys(live)) {
      const child = live[key];
      // A value the JSON copy cannot hold is not part of the record.
      if (!isJsonValue(child)) continue;
      count += 1;
      if (!Object.hasOwn(stored, key)) return false;
      if (!sameStoredValue(child, stored[key])) return false;
    }
    return count === Object.keys(stored).length;
  }
  if (typeof live === "number" && !Number.isFinite(live)) {
    // JSON writes every non-finite number as null. A stored copy therefore holds
    // `null` where the live record holds NaN or Infinity, and the two are the
    // same value to the journal — comparing them as different would mark the
    // record dirty on every frame and rewrite it for nothing.
    return stored === null || (typeof stored === "number" && !Number.isFinite(stored));
  }
  if (typeof live === "number" && typeof stored === "number") {
    // JSON writes every non-finite number as null, so they are all one value.
    if (!Number.isFinite(live) || !Number.isFinite(stored)) {
      return !Number.isFinite(live) && !Number.isFinite(stored);
    }
  }
  return false;
}

/** Whether `copyData` keeps this value, i.e. whether JSON can hold it. */
function isJsonValue(value) {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return true;
  if (kind !== "object") return false;
  if (Array.isArray(value)) return true;
  return isPlainObject(value);
}

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

export function validRecord(forkId, record) {
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
  if (!ledgerShapeOk(value)) return false;
  for (const forkId of value.order) {
    if (!validRecord(forkId, value.forks[forkId])) return false;
  }
  return true;
}

/**
 * Everything `validLedger` checks except the per-record field validation.
 *
 * Container shape, counters, the mirror between `order` and `forks`, and the
 * absence of duplicate ids — all in one walk that reads no record field. The
 * per-record walk is the expensive half: a record carries task text, targets,
 * and a return body, and validating each one on every write made a write cost
 * the whole session's fork history.
 *
 * A caller may use this alone only when it also validates every record whose
 * content could have changed. `serializeLedgerShared` does that for exactly
 * the records the ledger names as unsettled, and a record changed without
 * being named cannot reach the journal at all: the snapshot keeps the copy
 * that was already accepted, so the live tree's corruption stays out of the
 * stored history while the shape check still refuses a broken mirror.
 */
export function ledgerShapeOk(value) {
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
  }
  // A record outside the order cannot be paired or joined; refuse the snapshot
  // instead of restoring a half-addressable tree. The walk above proved every
  // ordered id is a key of `forks`, and it refused a duplicate, so the ordered
  // ids are a subset of the keys with the same cardinality as the ids. For
  // finite sets, subset plus equal size is equality: the key count settles the
  // reverse direction without a second walk and a hash lookup per fork.
  if (Object.keys(value.forks).length !== seen.size) return false;
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

/**
 * The container half of `validLedger`, without the per-record walk.
 *
 * The fast path in `serializeLedgerShared` reaches here only while the ledger
 * says its structure is clean and its fork id set matches the previous
 * snapshot, so the records that are not listed as dirty were already validated
 * when their copy was made. The records that are dirty still get the full
 * check in the caller, which keeps the guard where the change is.
 */
function validLedgerShallow(value) {
  if (!isPlainObject(value)) return false;
  if (value.version !== 2) return false;
  for (const key of ["seq", "closedSeq", "receiveSeq"]) {
    if (!Number.isInteger(value[key]) || value[key] < 0) return false;
  }
  if (!isPlainObject(value.forks)) return false;
  if (!Array.isArray(value.order)) return false;
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

/**
 * Capture the explicitly changed fork records for a persistence consumer.
 *
 * `ids` must come from an authoritative change source for that consumer. This
 * function does not infer changes or validate the ledger's containers; callers
 * that cannot prove the id set complete must use the full serializer instead.
 * Each returned record is an independent JSON-safe copy, so later changes to a
 * live record cannot change an already planned write. An invalid record refuses
 * the entire batch rather than turning it into a deletion.
 */
export function snapshotForkChanges(ledger, ids) {
  if (!isPlainObject(ledger?.forks) || ids == null || typeof ids[Symbol.iterator] !== "function") {
    return { ok: false, reason: "invalid-ledger-changes" };
  }
  const set = {};
  const del = [];
  const seen = new Set();
  for (const id of ids) {
    if (!isNonEmptyString(id)) return { ok: false, reason: "invalid-fork-id" };
    if (seen.has(id)) continue;
    seen.add(id);
    if (!Object.hasOwn(ledger.forks, id)) {
      del.push(id);
      continue;
    }
    const record = ledger.forks[id];
    if (!validRecord(id, record)) return { ok: false, reason: "invalid-record", forkId: id };
    put(set, id, copyData(record));
  }
  return { ok: true, set, del };
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
  // Live records and their nested values can also be changed through aliases
  // held by callers. Dirty marks therefore do not prove that the previous copy
  // is current. Compare a complete value copy before reusing any snapshot.
  // This costs O(ledger size); replacing it requires an enforced ownership
  // boundary, not merely a proxy around one of the aliases.
  if (meta && meta.snapshot) {
    // Compare record by record against a JSON-safe copy of that record alone.
    // The former form copied the whole ledger first and compared the copy, so
    // every snapshot held a second complete tree — the transcript included —
    // alive at the same time as the live one. On a session whose history runs
    // to gigabytes that allocation, not the comparison, is the pause the user
    // feels; one record at a time keeps the peak at a record's size while
    // answering exactly what the whole-tree copy answered.
    const old = meta.snapshot;
    const currentIds = Object.keys(ledger.forks);
    const oldIds = Object.keys(old.forks);
    let different = currentIds.length !== oldIds.length;
    if (different || currentIds.some((id, index) => id !== oldIds[index])) {
      meta.structDirty = true;
      different = true;
    }
    // This loop is not an optimisation: it is the only thing that notices a
    // record whose content moved without a record-level mark. A message
    // append is marked as a structural change, not a record one — the tests
    // in tests/ledger-record-diff.test.mjs pin that an append still arrives
    // through this comparison. Skipping it when `structDirty` is already true
    // looks free, because the full rebuild below copies every record anyway,
    // but the diff against the previous snapshot is assembled from what this
    // loop learns. Skipping it there lost an appended message.
    for (const forkId of currentIds) {
      // Compare against the stored copy in place. A record that cannot be
      // edited through an alias is still compared, because the marks are not a
      // proof of ownership — but the comparison no longer allocates a copy of
      // the record and two strings of it.
      if (!sameStoredValue(ledger.forks[forkId], old.forks[forkId])) {
        meta.dirtyForks.add(forkId);
        different = true;
      }
    }
    // The mailbox is compared by its own rule, and the rule depends on what
    // kind of array it is. One of ours cannot be reordered or edited, so its
    // append counter settles it in a single comparison. A plain array handed to
    // a hand-built ledger is untrusted: it is read and, when it differs, copied
    // whole — the price a foreign object pays, not the price of the hot path.
    const liveInbox = Array.isArray(ledger.rootInbox) ? ledger.rootInbox : [];
    const previousInbox = Array.isArray(old.rootInbox) ? old.rootInbox : [];
    const inboxHeld = meta.inboxRef === liveInbox;
    const previousInboxVersion = meta.inboxVersion ?? 0;
    const sameInbox =
      inboxHeld && isAppendOnlyInbox(liveInbox)
        ? inboxRelation(liveInbox, previousInbox, previousInboxVersion) === INBOX_SAME
        : JSON.stringify(copyData(liveInbox)) === JSON.stringify(previousInbox);
    if (!sameInbox) {
      meta.structDirty = true;
      different = true;
    }
    const currentKeys = [];
    const topCopies = new Map();
    for (const key of Object.keys(ledger)) {
      // The mailbox was compared above by its own rule.
      if (key === "rootInbox") continue;
      if (key === "forks") {
        currentKeys.push(key);
        continue;
      }
      const copy = copyData(ledger[key]);
      if (copy === undefined) continue;
      currentKeys.push(key);
      topCopies.set(key, copy);
    }
    const oldKeys = Object.keys(old).filter((key) => key !== "rootInbox");
    let keysDiffer =
      currentKeys.length !== oldKeys.length ||
      currentKeys.some((key, index) => key !== oldKeys[index]);
    if (!keysDiffer) {
      for (const [key, copy] of topCopies) {
        if (JSON.stringify(copy) !== JSON.stringify(old[key])) {
          keysDiffer = true;
          break;
        }
      }
    }
    if (keysDiffer) {
      meta.structDirty = true;
      different = true;
    }
    if (!different && !meta.structDirty && meta.dirtyForks.size === 0) {
      return meta.snapshot;
    }
  }
  const previous = meta?.snapshot ?? null;
  // Record-level fast path. A clean `structDirty` is the ledger's own claim
  // that no container field and no fork id set changed, so the container
  // copies from the previous snapshot are still exact: reuse them by reference
  // and re-copy only the records that moved. The set check below keeps the
  // claim honest — a fork that appeared or vanished without the mark falls
  // through to the full path instead of being silently dropped or resurrected.
  if (meta && previous && !meta.structDirty) {
    // One pass builds the next snapshot's fork map, so the two checks that
    // used to be separate costs — enumerate the previous snapshot's keys to
    // count them, and spread the old map to start a copy — disappear. The
    // record count comes from the snapshot itself, and each record is either
    // re-copied (it moved) or shared by reference (it did not). The check is
    // exactly as strong as before: every live id must be present in the
    // previous snapshot, and the counts must be equal.
    const forks = {};
    let seen = 0;
    let setsMatch = true;
    const liveKeys = Object.keys(ledger.forks);
    for (const forkId of liveKeys) {
      seen += 1;
      if (meta.dirtyForks.has(forkId)) {
        const record = ledger.forks[forkId];
        if (!validRecord(forkId, record)) {
          setsMatch = false;
          break;
        }
        // A dirty record the previous snapshot never held is a fork that
        // appeared. The fast path reuses the previous container fields, so
        // accepting it would store a tree whose `order` does not name this
        // fork — and a count match cannot see it, because one fork leaving
        // while another arrives is the same number of records. `validLedger`
        // rejects that tree on load and the whole fork history is discarded,
        // so a record that is not in the previous snapshot ends the fast path
        // and sends the write to the structural rebuild, which recomputes the
        // containers from the live tree.
        if (!Object.hasOwn(previous.forks, forkId)) {
          setsMatch = false;
          break;
        }
        put(forks, forkId, copyData(record));
        meta.forkRefs.set(forkId, record);
        continue;
      }
      if (!Object.hasOwn(previous.forks, forkId)) {
        setsMatch = false;
        break;
      }
      put(forks, forkId, previous.forks[forkId]);
    }
    if (setsMatch && seen === meta.snapshotForkCount && validLedgerShallow(ledger)) {
      // Nothing changed, so the copy stands. Remember which live array it
      // mirrors: the next append can then share this copy's prefix.
      if (Array.isArray(ledger.rootInbox)) meta.inboxRef = ledger.rootInbox;
      const next = {
        version: ledger.version,
        seq: ledger.seq,
        closedSeq: ledger.closedSeq,
        receiveSeq: ledger.receiveSeq,
        forks,
        order: previous.order,
        queues: previous.queues,
        levels: previous.levels,
        rootInbox: previous.rootInbox,
        totals: previous.totals,
      };
      const moved = new Set(meta.dirtyForks);
      meta.snapshot = next;
      meta.snapshotForkCount = seen;
      noteSnapshotStep(ledger, next, previous, { set: moved, del: [] });
      meta.dirtyForks.clear();
      return next;
    }
  }
  if (!validLedger(ledger)) return copyData(createBracketLedger());
  if (!meta) return copyData(ledger);
  const forks = {};
  const live = new Set();
  // The rebuild already visits every live id. Preserve its exact record-level
  // result so each persistence baseline can consume it without another walk.
  const set = new Set();
  const del = new Set();
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
    set.add(forkId);
    meta.forkRefs.set(forkId, record);
  }
  // The previous snapshot is the source of truth for removals. The live
  // reference cache can be incomplete when a ledger was externally rebuilt.
  if (previous) {
    for (const forkId of Object.keys(previous.forks)) {
      if (!live.has(forkId)) del.add(forkId);
    }
  }
  for (const forkId of meta.forkRefs.keys()) {
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
    // it while `serializeLedger` still reports it. It is also the field that
    // grows with a root-level conversation, so an append reuses the prefix
    // copies instead of repeating them.
    rootInbox: inboxForSnapshot(meta, previous, Array.isArray(ledger.rootInbox) ? ledger.rootInbox : []),
    totals: copyData(ledger.totals),
  };
  meta.snapshot = next;
  meta.snapshotForkCount = live.size;
  meta.structDirty = false;
  // This step is exact even for structural changes: all newly copied records
  // and all removals were recorded while building the snapshot. A first
  // snapshot has no predecessor and therefore cannot serve a delta query.
  noteSnapshotStep(ledger, next, previous, previous ? { set, del } : null);
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
  // The root's mailbox is not a bracket record, so no loop above rebuilds it.
  // The snapshot stores it for one reason — a message addressed to `/` has no
  // record to live in, and a reload without it drops the message silently —
  // so restoring everything else and leaving this field empty is the one way
  // the snapshot can be read back worse than it was written.
  out.rootInbox = mailboxFrom(Array.isArray(value.rootInbox) ? value.rootInbox : []);
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
  const queueIndex = new Map();
  for (const ownerId of Object.keys(out.queues)) {
    queueIndex.set(ownerId, new Set(out.queues[ownerId]));
  }
  if (!pairingProblems(out, queueIndex).ok) return { ok: false, ledger: createBracketLedger() };
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
  let initialized = false;
  if (!isPlainObject(record.remaining)) { record.remaining = copyCounts(record.budget); initialized = true; }
  if (!isPlainObject(record.spent)) { record.spent = {}; initialized = true; }
  if (!isPlainObject(record.charges)) { record.charges = {}; initialized = true; }
  // Validation and duplicate checks below may return before charging. Legacy
  // field initialization is still a mutation and must survive that return.
  if (initialized) markRecordDirty(ledger, forkId);
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
  let initialized = false;
  if (!isPlainObject(record.charges)) { record.charges = {}; initialized = true; }
  if (!isPlainObject(record.remaining)) { record.remaining = copyCounts(record.budget); initialized = true; }
  if (!isPlainObject(record.spent)) { record.spent = {}; initialized = true; }
  // A missing charge can return immediately after initializing legacy fields.
  if (initialized) markRecordDirty(ledger, forkId);
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
