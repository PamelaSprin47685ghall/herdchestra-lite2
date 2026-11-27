// Ledger charges: budget validation, count copying, and per-fork cost arithmetic.
// Pure data and arithmetic. No host objects, no clock, no I/O.

import { isPlainObject } from "./plain.mjs";
import { formatAmount } from "./amount.mjs";
import { markLedgerStructDirty, markRecordDirty } from "./ledger-cache.mjs";


const listeners = Symbol("ledger listeners");



export function subscribeLedger(ledger, listener) {
  if (!ledger[listeners]) Object.defineProperty(ledger, listeners, { value: new Set() });
  ledger[listeners].add(listener);
}

// Every caller of `changed` has just moved a counter, a queue, a level list,
// or a record. A record-only change may reach here too; the serializer then
// rebuilds the small top-level arrays and still reuses every untouched record.
export function changed(ledger) {
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


export function failure(code, reason, details) {
  return details && typeof details === "object"
    ? { ok: false, code, reason, ...details }
    : { ok: false, code, reason };
}



export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}



export function isDepth(value) {
  return Number.isInteger(value) && value >= 0;
}



export function put(object, key, value) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}



export function forkOf(ledger, forkId) {
  if (!ledger || typeof ledger !== "object") return null;
  if (typeof forkId !== "string" || forkId === "") return null;
  const record = ledger.forks?.[forkId];
  return record && typeof record === "object" ? record : null;
}



// -- Branch account (pure arithmetic; no clock, no I/O) --------------------

export function validBudget(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "") return false;
    const amount = value[key];
    if (!Number.isInteger(amount) || amount < 0) return false;
  }
  return true;
}



export function copyCounts(source) {
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

/** The branch's own account: what is left and what was spent. */


/** The branch's own account: what is left and what was spent. */
function accountOf(record) {
  return {
    remaining: copyCounts(record.remaining),
    spent: copyCounts(record.spent),
  };
}

// Budget-charge dedupe, held in memory only.
//
// A js beat can be replayed — the model retries, a ticket is re-entered, a host
// re-executes the same call — and the same inner call must not be paid for
// twice. The record's own `charges` table served this purpose and retired with
// the amend ledger. Keeping the set *beside* the ledger, keyed by its identity,
// is what makes it invisible to persistence: `serializeLedger` copies the tree
// and `validLedger` validates it, so a field there would become a stored one.
// A reload rebuilds the bill from the budget anyway, and the case worth memory
// for is a replay within one process.


// Budget-charge dedupe, held in memory only.
//
// A js beat can be replayed — the model retries, a ticket is re-entered, a host
// re-executes the same call — and the same inner call must not be paid for
// twice. The record's own `charges` table served this purpose and retired with
// the amend ledger. Keeping the set *beside* the ledger, keyed by its identity,
// is what makes it invisible to persistence: `serializeLedger` copies the tree
// and `validLedger` validates it, so a field there would become a stored one.
// A reload rebuilds the bill from the budget anyway, and the case worth memory
// for is a replay within one process.
const chargedCalls = new WeakMap();

const MAX_TRACKED_CALLS = 4096;

/** The dedupe key for one call, or null when the caller named none. */


/** The dedupe key for one call, or null when the caller named none. */
function chargeKeyOf(forkId, toolCallId) {
  return typeof toolCallId === "string" && toolCallId !== ""
    ? `${forkId}\u0000${toolCallId}`
    : null;
}

/**
 * Remember a spend so a replay is a no-op.
 *
 * Insertion order is the eviction order: when the table is full the oldest key
 * leaves. That bounds what a long session spends on bookkeeping without a timer
 * or a sweep, and a key old enough to be evicted is old enough that its call is
 * not being replayed.
 */


/**
 * Remember a spend so a replay is a no-op.
 *
 * Insertion order is the eviction order: when the table is full the oldest key
 * leaves. That bounds what a long session spends on bookkeeping without a timer
 * or a sweep, and a key old enough to be evicted is old enough that its call is
 * not being replayed.
 */
function rememberCharged(ledger, key) {
  if (key === null) return;
  let seen = chargedCalls.get(ledger);
  if (!seen) {
    seen = new Map();
    chargedCalls.set(ledger, seen);
  }
  seen.set(key, true);
  if (seen.size > MAX_TRACKED_CALLS) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
}

/**
 * Charge one tool call against a branch. A share larger than the turns left
 * spends what is left, so the rest of the beat still runs.
 *
 * A repeat of the same call id answers `alreadyCharged` before the budget is
 * consulted: the call was paid for already, and by then the branch may have
 * spent the rest, so asking whether it could afford a second charge would turn
 * a settled call into a refusal.
 */


/**
 * Charge one tool call against a branch. A share larger than the turns left
 * spends what is left, so the rest of the beat still runs.
 *
 * A repeat of the same call id answers `alreadyCharged` before the budget is
 * consulted: the call was paid for already, and by then the branch may have
 * spent the rest, so asking whether it could afford a second charge would turn
 * a settled call into a refusal.
 */
export function applyCharge(ledger, forkId, charge = {}) {
  const record = forkOf(ledger, forkId);
  if (!record) return failure("UNKNOWN_FORK", `Unknown fork "${forkId}".`);
  let initialized = false;
  if (!isPlainObject(record.remaining)) { record.remaining = copyCounts(record.budget); initialized = true; }
  if (!isPlainObject(record.spent)) { record.spent = {}; initialized = true; }
  // Validation below may return before charging. Legacy field initialization is
  // still a mutation and must survive that return.
  if (initialized) markRecordDirty(ledger, forkId);
  const tool = typeof charge.tool === "string" ? charge.tool : "";
  if (tool === "") {
    return failure("INVALID_TOOL", "A charge must name the tool it spends.");
  }
  const callKey = chargeKeyOf(forkId, charge.toolCallId);
  const seen = callKey === null ? null : chargedCalls.get(ledger);
  if (seen && seen.has(callKey)) {
    return { ok: true, amount: 0, alreadyCharged: true, ...accountOf(record) };
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
  markRecordDirty(ledger, forkId);
  rememberCharged(ledger, callKey);
  return { ok: true, amount, ...accountOf(record) };
}



