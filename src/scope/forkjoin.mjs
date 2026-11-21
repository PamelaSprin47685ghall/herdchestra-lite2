// Fork/join bracket ledger: pairing, reparenting, sibling order, fold gates.
//
// A fork opens a left bracket. A join (parent side) or a return (child side)
// closes a right bracket. Brackets may interleave; every pair must close.
// This module is pure data and arithmetic. It holds no host objects, reads no
// clock, and performs no I/O.

const RUNNING = "running";
const READY = "ready";
const JOINED = "joined";
const FAILED = "failed";
// A blocked fork is a checkpoint entry, not a queue item: it records that this
// work is known and not yet startable. It never runs and never needs joining.
const BLOCKED = "blocked";

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
  return {
    version: 1,
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
  };
}

/**
 * Register one left bracket. Returns the fork record. Nothing blocks, so the
 * parent may register several forks in one beat.
 */
export function registerFork(ledger, spec) {
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
  if (!isNonEmptyString(s.intent)) {
    return failure("INVALID_INTENT", "intent must be a non-empty string.");
  }
  if (!isDepth(s.depth)) {
    return failure("INVALID_DEPTH", "depth must be a non-negative integer.");
  }
  if (s.budget !== undefined && !validBudget(s.budget)) {
    return failure("INVALID_BUDGET", "budget must be a plain object of non-negative numbers.");
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
    intent: s.intent.trim(),
    depth: s.depth,
    childDepth: s.depth + 1,
    openSeq: ledger.seq,
    closeSeq: null,
    closedOrder: null,
    readySeq: null,
    status: s.blocked === true ? BLOCKED : RUNNING,
    outcome: null,
    reason: null,
    reparentedFrom: null,
    // The branch's own account. A fork spec is the only place a branch budget
    // is born; the parent's balances never fund it and never shrink for it.
    budget,
    remaining,
    spent,
    charges: {},
    timeBudgetMs,
    startedAt,
    deadlineAt:
      timeBudgetMs !== null && startedAt !== null ? startedAt + timeBudgetMs : null,
    overtimeAt: null,
    // Waiting for another branch is not this branch's work. A pause freezes
    // the remaining time; resume shifts the deadline by the paused span.
    clockPausedAt: null,
    pausedMs: 0,
  };
  put(ledger.forks, s.forkId, record);
  ledger.order.push(s.forkId);
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
  return { ok: true, fork: record, position: queue.length - 1 };
}

/**
 * Parent side takes the earliest ready child. Stale queue entries (already
 * joined, or moved away by reparenting) are dropped on the way.
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
    if (!record || record.status !== READY || record.ownerId !== ownerId) {
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
    return { ok: true, fork: record };
  }
  if (blocked.length > 0) {
    return failure(
      "NO_ADMISSIBLE_CHILD",
      "No ready child can be delivered into this context.",
      { blocked },
    );
  }
  return failure("NO_READY_CHILD", "No child has returned yet.");
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
    return failure("SAME_OWNER", "A fork cannot be reparented to its own owner.");
  }
  let moved = 0;
  for (const forkId of ledger.order) {
    const record = forkOf(ledger, forkId);
    if (!record) continue;
    if (record.ownerId !== fromOwnerId) continue;
    // Blocked entries move too: they are the visible remainder of the plan,
    // and that visibility must follow the receiving branch. They still never
    // run and never enter the ready queue.
    if (record.status !== RUNNING && record.status !== BLOCKED) continue;
    record.reparentedFrom = fromOwnerId;
    record.ownerId = toOwnerId;
    moved += 1;
  }
  // Ready results already queued for the dying owner follow the same edge.
  // They append behind the dying owner's own result, so a grandparent always
  // sees the parent before the parent's children.
  const source = queueFor(ledger, fromOwnerId);
  const target = queueFor(ledger, toOwnerId);
  let transferred = 0;
  const remaining = [];
  for (const forkId of source) {
    const record = forkOf(ledger, forkId);
    if (record && record.status === READY) {
      record.ownerId = toOwnerId;
      target.push(forkId);
      transferred += 1;
      continue;
    }
    remaining.push(forkId);
  }
  ledger.queues[fromOwnerId] = remaining;
  return { ok: true, moved, transferred };
}

/** Drop one fork without a result. Used when a parent is cancelled. */
export function abandon(ledger, forkId, reason = null) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  if (record.status === JOINED) {
    return failure("FORK_ALREADY_JOINED", `Fork "${forkId}" is already joined.`);
  }
  ledger.seq += 1;
  record.status = FAILED;
  record.closeSeq = ledger.seq;
  record.outcome = FAILED;
  record.reason = typeof reason === "string" && reason !== "" ? reason : null;
  removeFromQueues(ledger, forkId);
  return { ok: true, fork: record };
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
 * registration order, so a receipt lists the same set every time it is read.
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
    if (record.ownerId !== ownerId || record.status !== READY) continue;
    out.push(forkId);
  }
  out.sort((a, b) => {
    const left = forkOf(ledger, a);
    const right = forkOf(ledger, b);
    return (left?.readySeq ?? 0) - (right?.readySeq ?? 0);
  });
  return out;
}

/** Fork ids this owner recorded as blocked by an unmet prerequisite. */
export function blockedChildren(ledger, ownerId) {
  const out = [];
  for (const forkId of ledger.order) {
    const fork = ledger.forks[forkId];
    if (!fork || fork.ownerId !== ownerId || fork.status !== BLOCKED) continue;
    out.push(forkId);
  }
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
const STATUSES = new Set([RUNNING, READY, JOINED, FAILED, BLOCKED]);

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
  if (!isNonEmptyString(record.intent)) return false;
  if (!isDepth(record.depth)) return false;
  if (!STATUSES.has(record.status)) return false;
  if (!Number.isInteger(record.openSeq) || record.openSeq < 0) return false;
  if (!validNumberMap(record.budget)) return false;
  if (!validNumberMap(record.remaining)) return false;
  if (!validNumberMap(record.spent)) return false;
  if (record.record !== null && record.record !== undefined) {
    if (typeof record.record !== "string") return false;
  }
  if (record.reason !== null && record.reason !== undefined) {
    if (typeof record.reason !== "string") return false;
  }
  return true;
}

/** True when a stored value can rebuild a bracket tree without guessing. */
export function validLedger(value) {
  if (!isPlainObject(value)) return false;
  if (value.version !== 1) return false;
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
  return true;
}

/** A JSON-safe copy of the tree, safe to persist with the scope state. */
export function serializeLedger(ledger) {
  if (!validLedger(ledger)) return copyData(createBracketLedger());
  return copyData(ledger);
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
    .filter((record) => record.status === READY)
    .sort((left, right) => (left.readySeq ?? 0) - (right.readySeq ?? 0));
  for (const record of ready) {
    if (!Number.isInteger(record.readySeq) || record.readySeq <= 0) {
      out.receiveSeq += 1;
      record.readySeq = out.receiveSeq;
    } else if (record.readySeq > out.receiveSeq) {
      out.receiveSeq = record.readySeq;
    }
    queueFor(out, record.ownerId).push(record.forkId);
  }
  // A tree that cannot be addressed consistently is not a partial tree: a
  // queue entry without a fork, or a joined level entry out of order, makes
  // every later take guess. Refuse the snapshot as a whole, exactly as a
  // malformed value is refused, so the session starts from a clean ledger.
  if (!assertPairing(out).ok) return { ok: false, ledger: createBracketLedger() };
  return { ok: true, ledger: out };
}

/**
 * Rebuild a ledger, discarding the tree when its queues and levels do not
 * pair. Callers that also carry a receipt chain must use the checked form:
 * keeping receipts for a tree that just reset would leave a pending report
 * pointing at a fork no longer in the ledger.
 */
export function restoreLedger(value) {
  return restoreLedgerChecked(value).ledger;
}

export {
  RUNNING,
  READY,
  JOINED,
  FAILED,
  BLOCKED,
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

function format2(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
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
 * existing charge instead of spending twice. A share larger than the balance
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
    // without one reads as an unattributed extension block, so the balance
    // itself is stated here.
    return {
      ok: false,
      code: "BUDGET_EXHAUSTED",
      reason: `Tool "${tool}" has no work budget left on this branch (remaining ${left}, budget ${budget}).`,
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
  }
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
  return { ok: true, refunded: refund, ...accountOf(record) };
}

/**
 * Freeze a branch's clock. Waiting for another branch is not this branch's own
 * work, so the remaining time must not drain while it waits. The first pause
 * edge wins: a repeated call cannot move it.
 */
export function pauseClock(record, now = Date.now()) {
  if (!record || !Number.isFinite(record.deadlineAt)) return false;
  if (Number.isFinite(record.clockPausedAt)) return false;
  record.clockPausedAt = Number.isFinite(now) ? now : Date.now();
  return true;
}

/**
 * Release a paused clock and shift the deadline by the paused span, so the
 * branch resumes with exactly the time it had left. A resume without a pause
 * changes nothing.
 */
export function resumeClock(record, now = Date.now()) {
  if (!record || !Number.isFinite(record.deadlineAt)) return false;
  if (!Number.isFinite(record.clockPausedAt)) return false;
  const at = Number.isFinite(now) ? now : Date.now();
  const paused = Math.max(0, at - record.clockPausedAt);
  record.deadlineAt += paused;
  record.pausedMs = (Number.isFinite(record.pausedMs) ? record.pausedMs : 0) + paused;
  record.clockPausedAt = null;
  return true;
}

/** How much wall clock a branch has left. The deadline itself is overtime. */
export function deadlineInfo(record, now = Date.now()) {
  if (!record || !Number.isFinite(record.deadlineAt)) return { bounded: false };
  // A paused clock reads as the pause edge: the remaining time is frozen and
  // no overtime can begin until the branch resumes.
  const at = Number.isFinite(record.clockPausedAt)
    ? record.clockPausedAt
    : Number.isFinite(now)
      ? now
      : Date.now();
  const leftMs = record.deadlineAt - at;
  if (leftMs <= 0) return { bounded: true, overtime: true, leftMs: 0 };
  return { bounded: true, overtime: false, leftMs };
}

/** Render a branch's budget and clock the way the old scope line did. */
export function forkBudgetText(record, now = Date.now()) {
  if (!record || !isPlainObject(record.remaining)) return "";
  const entries = [];
  for (const tool of Object.keys(record.remaining).sort()) {
    const budget = record.budget?.[tool];
    if (budget === undefined) continue;
    entries.push(`${tool} ${format2(record.remaining[tool])}/${format2(budget)}`);
  }
  const tools = entries.join(", ");
  const info = deadlineInfo(record, now);
  if (!info.bounded) return tools;
  const timed = info.overtime
    ? "time OVERTIME (1s per tool)"
    : `time ${formatClock(info.leftMs)}/${formatClock(record.timeBudgetMs)}`;
  return tools === "" ? timed : `${tools}, ${timed}`;
}
