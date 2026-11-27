// Ledger charges: per-fork cost arithmetic and the in-memory replay guard.
// Pure data and arithmetic. No host objects, no clock, no I/O.
//
// The value predicates and object helpers live in `core/primitives.mjs`. This
// module re-exports the ones the ledger's callers already import from here, so
// one implementation serves every consumer and a fix reaches all of them.

import {
	copyCounts,
	formatCents,
	isNonEmptyString,
	isPlainObject,
	put,
	roundAmount,
	validBudget,
} from "../core/primitives.mjs";
import { ledgerMeta, markLedgerStructDirty, markRecordDirty } from "./ledger-cache.mjs";

export { copyCounts, isNonEmptyString, put, validBudget };

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
 * A refused charge. `details` spreads into the result, so a refusal can carry
 * its tool name and the numbers beside the code.
 */
export function failure(code, reason, details) {
	return details && typeof details === "object"
		? { ok: false, code, reason, ...details }
		: { ok: false, code, reason };
}

export function isDepth(value) {
	return Number.isInteger(value) && value >= 0;
}

export function forkOf(ledger, forkId) {
	if (!ledger || typeof ledger !== "object") return null;
	if (typeof forkId !== "string" || forkId === "") return null;
	const record = ledger.forks?.[forkId];
	return record && typeof record === "object" ? record : null;
}

// -- Branch account (pure arithmetic; no clock, no I/O) --------------------

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
// the amend ledger. Keeping the set on the ledger's runtime metadata, which no
// serializer copies and `validLedger` never inspects, is what makes it
// invisible to persistence. A reload rebuilds the bill from the budget anyway,
// and the case worth memory for is a replay within one process.
const MAX_TRACKED_CALLS = 4096;

/** The dedupe table for one ledger, created on first use, or null when untracked. */
function chargeTable(ledger) {
	const meta = ledgerMeta(ledger);
	if (!meta) return null;
	if (!meta.chargedCalls) meta.chargedCalls = new Map();
	return meta.chargedCalls;
}

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
function rememberCharged(ledger, key) {
	if (key === null) return;
	const seen = chargeTable(ledger);
	if (!seen) return;
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
	const seen = callKey === null ? null : chargeTable(ledger);
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
			reason: `Tool "${tool}" has no budget left on this branch (remaining ${formatCents(left)}/${formatCents(budget)}).`,
			tool,
			remaining: left,
			budget,
		};
	}
	const requested =
		Number.isFinite(charge.amount) && charge.amount > 0 ? charge.amount : 1;
	const amount = roundAmount(Math.min(requested, remaining));
	put(record.remaining, tool, roundAmount(remaining - amount));
	put(record.spent, tool, roundAmount((record.spent[tool] ?? 0) + amount));
	markRecordDirty(ledger, forkId);
	rememberCharged(ledger, callKey);
	return { ok: true, amount, ...accountOf(record) };
}
