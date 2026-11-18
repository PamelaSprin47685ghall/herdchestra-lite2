// Station fold: measured interior accounting, pool economics, and single-fork
// batch folding. Pure host-session manipulation plus pure analysis helpers;
// no business state lives here.

import {
	applyCollapses,
	collectPinnedMessages,
	filterRegrets,
	findBegin,
	findToolCallIndex,
	finishedReport,
	toolCalls,
} from "../transcript/index.mjs";
import { crossesHandoffBoundary } from "../transcript/collapse.mjs";
import { cloneMessage, finishedResultMessage } from "./messages.mjs";
import { charsToTokens } from "../host/pricing.mjs";
import { markSubsumedDescendants } from "../scope/index.mjs";

const WATERMARK_ECONOMIC = 0.82;
const WATERMARK_EMERGENCY = 0.9;

function findBeginEntry(manager, beginToolCallId) {
	try {
		const branch = manager?.getBranch?.() ?? [];
		for (const entry of branch) {
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			if (toolCalls(entry.message).some((call) => call.id === beginToolCallId)) return entry;
		}
	} catch {
		// A manager without getBranch cannot fork; the caller reports the error.
	}
	return null;
}

/** Count the payable characters of a message sequence. */
export function sliceChars(messages) {
	let chars = 0;
	for (const message of Array.isArray(messages) ? messages : []) {
		if (!message || typeof message !== "object") continue;
		const content = message.content;
		if (typeof content === "string") {
			chars += content.length;
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				if (block.type === "text") chars += String(block.text ?? "").length;
				else if (block.type === "thinking") {
					chars += String(block.thinking ?? block.text ?? "").length;
				} else if (block.type === "toolCall") {
					const args = block.arguments;
					chars += typeof args === "string" ? args.length : JSON.stringify(args ?? {}).length;
				}
			}
		}
	}
	return chars;
}

/** Net tokens an archived elder saves once its receipt and pins are kept. */
export function netRemovableTokens(record, tokensPerChar = 0.3) {
	if (!record || record.collapsed !== false) return 0;
	const interior = Number.isFinite(record.interiorTokens)
		? record.interiorTokens
		: charsToTokens(record.interiorChars ?? 0, tokensPerChar);
	const reportTokens = charsToTokens(
		finishedReport(record.report ?? "").length,
		tokensPerChar,
	);
	const pinTokens = Number.isFinite(record.pinTokens) ? record.pinTokens : 0;
	return Math.max(0, interior - reportTokens - pinTokens);
}

/** Measure a closing scope's open interior using the exact open interval. */
export function measureScopeInterior(
	base,
	beginToolCallId,
	endToolCallId,
	regrets,
	tokensPerChar = 0.3,
) {
	const begin = findBegin(base, beginToolCallId);
	const endIndex = findToolCallIndex(base, endToolCallId);
	if (!begin || endIndex < 0 || endIndex <= begin.resultIndex) {
		return { interiorChars: 0, pinTokens: 0 };
	}
	const slice = filterRegrets(
		base.slice(begin.resultIndex + 1, endIndex),
		regrets ?? [],
	);
	const interiorChars = sliceChars(slice);
	const pinned = collectPinnedMessages(slice, {});
	const pinTokens = charsToTokens(sliceChars(pinned), tokensPerChar);
	return { interiorChars, pinTokens };
}

function budgetSteps(budget) {
	let total = 0;
	if (budget && typeof budget === "object") {
		for (const value of Object.values(budget)) {
			if (Number.isFinite(value) && value >= 0) total += value;
		}
	}
	return Math.min(12, 1 + Math.ceil(0.65 * total));
}

function beginResultTokens(record, tokensPerChar) {
	return charsToTokens(finishedReport(record?.report ?? "").length, tokensPerChar);
}

/**
 * Decide whether a foldable pool should be folded in a single batch.
 * Pure so the economics can be tested without a host session.
 */
export function shouldFoldPool({
	pool,
	hotRecord,
	state,
	base,
	persistedEnd,
	budget,
	usageSnapshot,
	pricing,
	contextTokens,
	tokensPerChar = 0.3,
	emergency = false,
}) {
	const records = Array.isArray(pool) ? pool : [];
	if (records.length === 0) return { fold: false, reason: "empty" };
	const pHit = Number.isFinite(pricing?.pHit) ? Math.max(0, pricing.pHit) : 1e-6;
	const pMiss = Number.isFinite(pricing?.pMiss) ? Math.max(0, pricing.pMiss) : 10e-6;
	const cw = Number.isFinite(pricing?.contextWindow) ? pricing.contextWindow : null;
	const threshold = emergency ? WATERMARK_EMERGENCY : WATERMARK_ECONOMIC;

	let B_pool = 0;
	let A_paid = 0;
	for (const record of records) {
		B_pool += netRemovableTokens(record, tokensPerChar);
		A_paid += Number.isFinite(record?.paidRentCost) ? record.paidRentCost : 0;
	}

	if (cw && Number.isFinite(contextTokens) && contextTokens >= threshold * cw) {
		return { fold: true, reason: "watermark", B_pool, A_paid, pHit, pMiss };
	}
	if (B_pool <= 0) return { fold: false, reason: "no-savings", B_pool, A_paid };

	let M_after = 0;
	const first = records[0];
	const usage = usageSnapshot && typeof usageSnapshot === "object" ? usageSnapshot : null;
	if (
		usage &&
		Number.isFinite(usage.lastTotalInput) &&
		Number.isFinite(first?.baseInputTokens)
	) {
		const before = Math.max(
			0,
			usage.lastTotalInput - first.baseInputTokens + beginResultTokens(first, tokensPerChar),
		);
		M_after = Math.max(0, before - B_pool);
	} else {
		const begin = findBegin(base, first.beginToolCallId);
		const endIndex = findToolCallIndex(base, first.endToolCallId);
		if (begin && endIndex > begin.resultIndex) {
			const cut = Number.isInteger(persistedEnd) ? persistedEnd : (base?.length ?? 0);
			const tail = base.slice(begin.assistantIndex, cut);
			const after = applyCollapses(
				tail,
				records.map((record) => ({ ...record, collapsed: true })),
				state?.epoch ?? 0,
			);
			const preserved = charsToTokens(sliceChars(after), tokensPerChar);
			const raw = charsToTokens(sliceChars(tail), tokensPerChar);
			M_after = Math.max(0, preserved + Math.max(0, raw - preserved) * 0);
		}
	}

	const nHat = budgetSteps(budget);
	const value = A_paid + nHat * B_pool * pHit;
	const cost = Math.max(0, pMiss - pHit) * M_after;
	const fold = value > cost;
	return { fold, reason: fold ? "economics" : "hold", B_pool, A_paid, M_after, nHat, value, cost, pHit, pMiss };
}

/** Persisted tail boundary: a live unpersisted last message is replayed separately. */
function persistedTail(base, currentMessage, currentPersisted) {
	const source = Array.isArray(base) ? base : [];
	if (currentPersisted === false && currentMessage && source[source.length - 1] === currentMessage) {
		return source.length - 1;
	}
	return source.length;
}

/**
 * Fold a batch of archived elders into one branch operation. Records whose
 * begin/end left the branch are marked collapsed without a fork.
 */
export function foldBatch({
	manager,
	state,
	batch,
	base,
	currentMessage,
	currentPersisted,
	tokensPerChar = 0.3,
	epoch,
}) {
	const source = Array.isArray(base) ? base : [];
	const tailCut = persistedTail(source, currentMessage, currentPersisted);
	const valid = [];
	for (const record of batch ?? []) {
		const begin = findBegin(source, record.beginToolCallId);
		const endIndex = findToolCallIndex(source, record.endToolCallId);
		if (!begin || endIndex < 0 || endIndex <= begin.resultIndex) {
			record.collapsed = true;
			continue;
		}
		if (
			tailCut <= endIndex ||
			crossesHandoffBoundary(source, begin.resultIndex + 1, endIndex)
		) {
			record.collapsed = true;
			continue;
		}
		valid.push({ record, begin, endIndex });
	}
	if (valid.length === 0) {
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1 };
	}

	let first = valid[0];
	let beginEntry = findBeginEntry(manager, first.record.beginToolCallId);
	while (!beginEntry && valid.length > 1) {
		first.record.collapsed = true;
		valid.shift();
		first = valid[0];
		beginEntry = findBeginEntry(manager, first.record.beginToolCallId);
	}
	if (!beginEntry) {
		first.record.collapsed = true;
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1 };
	}

	const useEpoch = Number.isInteger(epoch) ? epoch : (state?.epoch ?? 0);
	const tailBefore = source.slice(first.begin.assistantIndex, tailCut);
	const records = valid.map((entry) => entry.record);
	const collapsed = records.map((record) => ({ ...record, collapsed: true }));
	const tailAfter = applyCollapses(tailBefore, collapsed, useEpoch);

	if (
		!manager ||
		typeof manager.appendMessage !== "function" ||
		typeof manager.branch !== "function"
	) {
		for (const record of records) record.collapsed = true;
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1 };
	}
	try {
		const parentId = beginEntry.parentId ?? null;
		if (parentId) manager.branch(parentId);
		else if (typeof manager.resetLeaf === "function") manager.resetLeaf();
		else throw new Error("resetLeaf unavailable");
		for (const message of tailAfter) manager.appendMessage(cloneMessage(message));
	} catch {
		for (const record of records) record.collapsed = true;
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1 };
	}

	for (const record of records) record.collapsed = true;
	markSubsumedDescendants(state, records);
	const savedTokens = Math.max(
		0,
		charsToTokens(sliceChars(tailBefore) - sliceChars(tailAfter), tokensPerChar),
	);
	const maxOrder = records.reduce(
		(max, record) => (Number.isInteger(record.order) && record.order > max ? record.order : max),
		-1,
	);
	return {
		foldedCount: records.length,
		reports: records.map((record) => record.report),
		savedTokens,
		maxOrder,
		rebased: true,
	};
}

/** Legacy single-elder fold, kept for isolated callers. */
function foldElder({ manager, elder, base, currentMessage, currentPersisted }) {
	const begin = findBegin(base, elder.beginToolCallId);
	const beginEntry = begin ? findBeginEntry(manager, elder.beginToolCallId) : null;
	if (!begin || !beginEntry) {
		elder.collapsed = true;
		return { folded: false, report: null, rebased: false };
	}
	const folded = foldBatch({
		manager,
		state: { collapses: [], epoch: elder.epoch ?? 0 },
		batch: [elder],
		base,
		currentMessage,
		currentPersisted,
		epoch: elder.epoch ?? 0,
	});
	return { folded: folded.foldedCount > 0, report: elder.report, rebased: folded.rebased };
}

export { findBeginEntry, foldElder, WATERMARK_ECONOMIC, WATERMARK_EMERGENCY };
