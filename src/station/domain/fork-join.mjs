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
import { decideAbandon } from "../../scope/abandon.mjs";
import { normalizeBudget, validBudget } from "../../scope/budget.mjs";
import { normalizeTargets, validTargets } from "../../scope/targets.mjs";
import { publicScopeId, validScopeId } from "../../scope/scope-id.mjs";
import { resolveModelSelector } from "../../scope/model-selector.mjs";
import { latestReceiptOf } from "../../scope/receipts.mjs";
import { trimText } from "../messages.mjs";

export { decideAbandon };

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

/**
 * Check every fork argument without changing state. Returns the normalized
 * budget on success so the caller never normalizes twice.
 */
export function validateFork(args) {
	const intent = trimText(args?.intent);
	if (intent === "") return { ok: false, code: "INVALID_INTENT" };
	if (!Object.hasOwn(args ?? {}, "budget") || !validBudget(args.budget)) {
		return { ok: false, code: "INVALID_BUDGET" };
	}
	const budget = normalizeBudget(args.budget);
	if (!validBudget(budget)) return { ok: false, code: "INVALID_BUDGET" };
	if (!validTargets(args?.targets)) {
		return { ok: false, code: "INVALID_TARGETS" };
	}
	if (args.model !== undefined && args.model !== null && typeof args.model !== "string") {
		return { ok: false, code: "INVALID_ARGUMENT" };
	}
	if (args.blocked !== undefined && typeof args.blocked !== "boolean") {
		return { ok: false, code: "INVALID_ARGUMENT" };
	}
	if (!validScopeId(args?.scopeId) || args.scopeId.toLowerCase() === "root") {
		return { ok: false, code: "INVALID_SCOPE_ID" };
	}
	return {
		ok: true,
		scopeId: args.scopeId,
		intent,
		budget,
		targets: normalizeTargets(args.targets),
		model: typeof args.model === "string" ? args.model.trim() : null,
		blocked: args.blocked === true,
	};
}

/**
 * Validate a whole fork batch before any state changes. One bad item rejects
 * the batch: a half-open batch would leave the model unsure which brackets it
 * owns.
 */
export function validateForkBatch(args) {
	if (!Array.isArray(args?.forks) || args.forks.length === 0) {
		return { ok: false, code: "INVALID_FORKS", index: -1 };
	}
	const items = [];
	for (let index = 0; index < args.forks.length; index += 1) {
		const item = validateFork(args.forks[index]);
		if (!item.ok) return { ok: false, code: item.code, index };
		items.push(item);
	}
	return { ok: true, items };
}

/**
 * The register decision: duplicate scope ids, model selectors and start
 * admission. The handler still registers, spawns, defers and reports.
 *
 * Items must already be validated by `validateForkBatch`. Forks are plain
 * records; the module reads their status/scope id and mutates nothing.
 */
export function decideRegister({
	items = [],
	forks = [],
	models = null,
	hasSpawner = false,
	receiptChars = [],
	baseTokens = Number.POSITIVE_INFINITY,
	tokensPerChar = 0.3,
	window = null,
	reserve,
	margin,
} = {}) {
	const known = new Set();
	for (const fork of Array.isArray(forks) ? forks : []) {
		if (!fork || fork.status === "blocked") continue;
		known.add(publicScopeId(fork).toLowerCase());
	}
	const next = [];
	let needsSpawn = false;
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!item || typeof item.scopeId !== "string") {
			return { ok: false, code: "INVALID_SCOPE_ID", index };
		}
		const key = item.scopeId.toLowerCase();
		if (known.has(key)) {
			return {
				ok: false,
				code: "DUPLICATE_SCOPE_ID",
				index,
				scopeId: item.scopeId,
			};
		}
		known.add(key);
		if (item.blocked !== true) needsSpawn = true;
		next.push({ ...item });
	}
	if (needsSpawn && hasSpawner !== true) {
		return { ok: false, code: "CHILD_SPAWNER_UNAVAILABLE" };
	}
	for (let index = 0; index < next.length; index += 1) {
		const item = next[index];
		if (item.model == null || item.blocked === true) continue;
		const resolved = resolveModelSelector(models, item.model);
		if (!resolved.ok) {
			return {
				ok: false,
				code: resolved.code,
				index,
				selector: item.model,
				available: resolved.available,
				availableTotal: resolved.availableTotal,
			};
		}
		next[index] = {
			...item,
			modelOverride: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
		};
	}
	for (let index = 0; index < next.length; index += 1) {
		const item = next[index];
		if (item.blocked === true) continue;
		const override = item.modelOverride?.contextWindow;
		const itemWindow =
			Number.isFinite(override) && override > 0 ? override : window;
		const verdict = decideForkAdmission({
			baseTokens,
			receiptChars: receiptChars[index] ?? 0,
			tokensPerChar,
			window: itemWindow,
			reserve,
			margin,
		});
		if (!verdict.ok) {
			return {
				ok: false,
				code: "FORK_CONTEXT_EXCEEDED",
				index,
				reason: verdict.reason,
				admission: verdict.code,
				limit: verdict.limit,
				projected: verdict.projected,
				reserve: verdict.reserve,
				margin: verdict.margin,
				overBy: verdict.overBy,
			};
		}
	}
	return { ok: true, items: next, needsSpawn };
}

/** The return gate: identity, record, status and receiver, before any commit. */
export function decideReturn({
	identityForkId = "",
	record = null,
	receiverId = "",
	orphans = [],
} = {}) {
	if (typeof identityForkId !== "string" || identityForkId === "") {
		return { ok: false, code: "NOT_A_CHILD" };
	}
	if (!record || typeof record !== "object") {
		return { ok: false, code: "UNKNOWN_FORK" };
	}
	if (record.status !== "running") {
		return {
			ok: false,
			code: "FORK_NOT_RUNNING",
			status: record.status,
		};
	}
	if (typeof receiverId !== "string" || receiverId === "") {
		return { ok: false, code: "ORPHANS_WITHOUT_RECEIVER" };
	}
	return {
		ok: true,
		record,
		receiverId,
		orphans: Array.isArray(orphans) ? orphans : [],
	};
}

/** The ready gate and outcome normalization; the ledger mutation stays out. */
export function decideReady({ record = null, outcome = {} } = {}) {
	if (!record || typeof record !== "object") {
		return { ok: false, code: "UNKNOWN_FORK" };
	}
	if (record.status !== "running") {
		return { ok: false, code: "FORK_NOT_RUNNING", status: record.status };
	}
	const ok = outcome?.ok !== false;
	const reason =
		typeof outcome?.reason === "string" && outcome.reason !== ""
			? outcome.reason
			: null;
	const recordText =
		typeof outcome?.record === "string" ? outcome.record : null;
	return {
		ok: true,
		outcome: {
			ok,
			...(reason === null ? {} : { reason }),
			...(recordText === null ? {} : { record: recordText }),
		},
	};
}
