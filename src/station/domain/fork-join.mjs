// Pure fork/join decisions for the Station.
//
// The Station owns the bracket ledger, the receipt chain, the identity, and
// every side effect (take, commit, persistence, rendering). This module owns
// admission, the pending-report obligation, and the elder binding. It takes
// plain snapshots, returns plain values, never mutates its inputs, and imports
// no Station or host module.

import {
	estimateJoinTokens,
	joinAdmission,
} from "../../scope/admission.mjs";
import { latestReceiptOf } from "../../scope/receipts.mjs";

function admission({ baseTokens, recordChars, tokensPerChar, window, reserve, margin } = {}) {
	const projected = estimateJoinTokens({
		baseTokens,
		recordChars,
		tokensPerChar,
	});
	return joinAdmission({ window, projected, reserve, margin });
}

/** Can the parent's next request hold a child record of this size? */
export function decideJoinAdmission({
	baseTokens,
	recordChars,
	tokensPerChar,
	window,
	reserve,
	margin,
} = {}) {
	return admission({
		baseTokens,
		recordChars,
		tokensPerChar,
		window,
		reserve,
		margin,
	});
}

/** Can the parent's next request hold a fork receipt of this size? */
export function decideForkAdmission({
	baseTokens,
	receiptChars,
	tokensPerChar,
	window,
	reserve,
	margin,
} = {}) {
	return admission({
		baseTokens,
		recordChars: receiptChars,
		tokensPerChar,
		window,
		reserve,
		margin,
	});
}

/**
 * The receipt the next join must summarize, or null when none is pending.
 *
 * The level key carries the relay generation and epoch, so a handoff or a
 * promotion changes it. The obligation itself does not disappear with the
 * key: an unreported receipt still names the elder the next join must
 * summarize, so fall back to the chain itself.
 */
export function decidePendingReport({
	receipts = [],
	levelKey = "",
	reports = null,
	ownerId = "root",
} = {}) {
	const list = Array.isArray(receipts) ? receipts : [];
	const latest = latestReceiptOf(list, levelKey) ?? lastUnreportedReceipt(list);
	if (latest) {
		// A receipt that already carries a report has discharged its obligation.
		// Without this check a persisted chain whose youngest receipt was reported
		// would demand the same summary forever.
		if (typeof latest.report === "string" && latest.report.trim() !== "") return null;
		return {
			forkId: latest.forkToolCallId,
			closeToolCallId: latest.closeToolCallId,
		};
	}
	return pendingOf(
		reports instanceof Map ? reports.get(ownerId) : reports?.[ownerId],
	);
}

/** The youngest receipt anywhere in the chain that still owes a report. */
function lastUnreportedReceipt(receipts) {
	let best = null;
	for (const entry of receipts) {
		if (!entry || typeof entry.closeToolCallId !== "string") continue;
		if (typeof entry.report === "string" && entry.report.trim() !== "") continue;
		if (!best || entry.closedOrder >= best.closedOrder) best = entry;
	}
	return best;
}

/** Accept the legacy string form as well as the record written now. */
function pendingOf(value) {
	if (typeof value === "string" && value !== "") {
		return { forkId: value, closeToolCallId: null };
	}
	if (value && typeof value === "object" && typeof value.forkId === "string") {
		return {
			forkId: value.forkId,
			closeToolCallId: value.closeToolCallId ?? null,
		};
	}
	return null;
}

/**
 * Is a waiting join's elder binding still the receipt the model read?
 *
 * `cleared` means the chain no longer owes the expected report; `moved` means
 * another join advanced it. The caller renders the named receipt; this module
 * only names the side and the fork id.
 */
export function decideJoinBinding({ expected = null, current = null } = {}) {
	const want = expected && typeof expected === "object" ? expected : null;
	const now = current && typeof current === "object" ? current : null;
	if (want === null && now === null) return { ok: true };
	if (
		want !== null &&
		now !== null &&
		(want.closeToolCallId ?? want.forkId) ===
			(now.closeToolCallId ?? now.forkId)
	) {
		return { ok: true };
	}
	if (now === null) {
		return {
			ok: false,
			code: "STALE_ELDER_REPORT",
			side: "cleared",
			forkId: want?.forkId ?? null,
		};
	}
	return {
		ok: false,
		code: "STALE_ELDER_REPORT",
		side: "moved",
		forkId: now.forkId ?? null,
	};
}
