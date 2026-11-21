// Right-bracket receipts: which joined child record may be shortened.
//
// A receipt is one successful scope_join. It names the left bracket, the
// right bracket, and the summary of the receipt that closed before it. The
// list is stored in the persisted scope state, so a reload can still tell an
// elder record from the newest one.
//
// This module is pure. It reads no clock, holds no host object, and never
// deletes a message: folding a receipt only shortens the text of its own
// right bracket.

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Build one receipt record. Returns null when the identity is incomplete:
 * a record without both brackets cannot be folded or restored safely.
 */
export function createReceiptRecord(spec) {
  const source = spec && typeof spec === "object" ? spec : {};
  if (!isNonEmptyString(source.forkToolCallId)) return null;
  if (!isNonEmptyString(source.closeToolCallId)) return null;
  return {
    forkToolCallId: source.forkToolCallId,
    ...(isNonEmptyString(source.scopeId) ? { scopeId: source.scopeId } : {}),
    closeToolCallId: source.closeToolCallId,
    levelKey: typeof source.levelKey === "string" ? source.levelKey : "",
    closedOrder: isCount(source.closedOrder) ? source.closedOrder : 0,
    report: isNonEmptyString(source.report) ? source.report.trim() : null,
    collapsed: false,
  };
}

/** Copy only the fields a stored receipt owns, so reloads stay predictable. */
export function copyReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  const copy = createReceiptRecord(receipt);
  if (!copy) return null;
  if (receipt.collapsed === true) copy.collapsed = true;
  return copy;
}

/** Append one receipt, replacing a record with the same right bracket. */
export function addReceipt(receipts, receipt) {
  const list = Array.isArray(receipts) ? receipts : [];
  const next = createReceiptRecord(receipt);
  if (!next) return list.slice();
  const out = list.filter((entry) => entry?.closeToolCallId !== next.closeToolCallId);
  out.push(next);
  return out;
}

/**
 * Attach a summary to the receipt that is still waiting for one at this
 * level. A report belongs to the previous right bracket, never to the one
 * this join is about to take, so the caller resolves the target first.
 */
export function attachReport(receipts, closeToolCallId, report) {
  const text = typeof report === "string" ? report.trim() : "";
  if (text === "" || !isNonEmptyString(closeToolCallId)) return receipts;
  let changed = false;
  const out = receipts.map((entry) => {
    if (entry?.closeToolCallId !== closeToolCallId) return entry;
    changed = true;
    return { ...entry, report: text };
  });
  return changed ? out : receipts;
}

/** The youngest receipt of one level, or null when the level is empty. */
export function latestReceiptOf(receipts, levelKey) {
  const list = Array.isArray(receipts) ? receipts : [];
  let best = null;
  for (const entry of list) {
    if (!entry || entry.levelKey !== levelKey) continue;
    if (!best || entry.closedOrder > best.closedOrder) best = entry;
  }
  return best;
}

/**
 * Receipts that may be shortened now.
 *
 * Three gates keep the newest evidence intact:
 * - the level has a younger receipt, so a summary exists to replace the text;
 * - the receipt carries a report, so shortening loses no conclusion;
 * - the receipt is not the youngest one, which stays complete.
 *
 * A receipt without a report stays readable in full. This is the HOLD case:
 * the summary was never committed, so the text must survive.
 *
 * `collapsed` records that a projection already shortened this receipt. It
 * does not remove the receipt from this list: every request projects from the
 * stored branch, so the shortening must be applied again on every pass. The
 * replacement is idempotent, and skipping a collapsed receipt would show the
 * full record again on the next turn.
 */
export function foldableReceipts(receipts) {
  const list = Array.isArray(receipts) ? receipts : [];
  const youngest = new Map();
  for (const entry of list) {
    if (!entry) continue;
    const current = youngest.get(entry.levelKey);
    if (!current || entry.closedOrder > current.closedOrder) {
      youngest.set(entry.levelKey, entry);
    }
  }
  const out = [];
  for (const entry of list) {
    if (!entry) continue;
    if (typeof entry.report !== "string" || entry.report.trim() === "") continue;
    if (youngest.get(entry.levelKey) === entry) continue;
    out.push(entry);
  }
  return out;
}

/** Mark one receipt as shortened after the projection replaced its text. */
export function markCollapsed(receipts, closeToolCallId, collapsed = true) {
  let changed = false;
  const out = receipts.map((entry) => {
    if (entry?.closeToolCallId !== closeToolCallId) return entry;
    if (entry.collapsed === collapsed) return entry;
    changed = true;
    return { ...entry, collapsed };
  });
  return changed ? out : receipts;
}

export function validReceipts(value) {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    if (!isNonEmptyString(entry.forkToolCallId)) return false;
    if (!isNonEmptyString(entry.closeToolCallId)) return false;
    if (typeof entry.levelKey !== "string") return false;
    if (!isCount(entry.closedOrder)) return false;
    if (entry.report !== null && typeof entry.report !== "string") return false;
    if (entry.collapsed !== undefined && typeof entry.collapsed !== "boolean") return false;
  }
  return true;
}
