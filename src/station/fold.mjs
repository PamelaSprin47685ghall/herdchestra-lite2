/**
 * Station fold: measured interior accounting, pool economics, and single-fork
 * batch folding. Pure host-session manipulation plus pure analysis helpers;
 * no business state lives here.
 */

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
import { cloneMessage } from "./messages.mjs";
import { charsToTokens } from "../host/pricing.mjs";
import { appendHistoryMessage } from "../host/hack-context.mjs";
import {
	CACHE_TTL_MS,
	capCachePositions,
	cacheIsFresh,
	markSubsumedDescendants,
	modelCacheFor,
} from "../scope/index.mjs";

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

/**
 * Net tokens an archived elder saves after keeping its receipt, pins, and user messages.
 */
export function netRemovableTokens(record, tokensPerChar = 0.3, key = null) {
	if (!record || record.collapsed !== false) return 0;
	const sameTokenizer = key === (record.measuredModelKey ?? null);
	const interior = sameTokenizer && Number.isFinite(record.interiorTokens)
		? record.interiorTokens
		: charsToTokens(record.interiorChars ?? 0, tokensPerChar);
	const reportTokens = charsToTokens(
		finishedReport(record.report ?? "").length,
		tokensPerChar,
	);
	const pinTokens = Number.isFinite(record.pinChars)
		? charsToTokens(record.pinChars, tokensPerChar)
		: sameTokenizer && Number.isFinite(record.pinTokens) ? record.pinTokens : 0;
	const userTokens = charsToTokens(record.userChars ?? 0, tokensPerChar);
	return Math.max(0, interior - reportTokens - pinTokens - userTokens);
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
		return { interiorChars: 0, pinTokens: 0, pinChars: 0, userChars: 0 };
	}
	const slice = filterRegrets(
		base.slice(begin.resultIndex + 1, endIndex),
		regrets ?? [],
	);
	const interiorChars = sliceChars(slice);
	const pinned = collectPinnedMessages(slice, {});
	const pinChars = sliceChars(pinned);
	const pinTokens = charsToTokens(pinChars, tokensPerChar);
	const userChars = sliceChars(slice.filter((message) => message?.role === "user"));
	return { interiorChars, pinTokens, pinChars, userChars };
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

// -- Multi-model fold economics ---------------------------------------------

/**
 * Cache view for one model key: the provider still holds messages
 * [0, cachedUntilPos) while lastUsedAt sits inside the five-minute TTL.
 * Returns { pos, tpc, fresh }; pos is an exclusive message index and tpc is
 * the model's measured tokens-per-char density.
 */
function cacheView(state, key, now, fallbackTpc) {
	const entry = modelCacheFor(state, key);
	const fallback =
		Number.isFinite(fallbackTpc) && fallbackTpc > 0 ? fallbackTpc : 0.3;
	if (!entry) return { pos: 0, tpc: fallback, fresh: false };
	const fresh = cacheIsFresh(entry, now, CACHE_TTL_MS);
	const pos =
		fresh && Number.isInteger(entry.cachedUntilPos) && entry.cachedUntilPos > 0
			? entry.cachedUntilPos
			: 0;
	const tpc =
		Number.isFinite(entry.tokensPerChar) && entry.tokensPerChar > 0
			? entry.tokensPerChar
			: fallback;
	return { pos, tpc, fresh };
}

/** Normalize an outer-model descriptor's pricing defensively. */
function outerPricing(descriptor, fallback) {
	const raw = descriptor && typeof descriptor === "object" ? descriptor.pricing : null;
	const source = raw && typeof raw === "object" ? raw : {};
	const pick = (a, b) =>
		Number.isFinite(a) ? Math.max(0, a) : Number.isFinite(b) ? Math.max(0, b) : null;
	return {
		pHit: pick(source.pHit, fallback.pHit) ?? 0,
		pMiss: pick(source.pMiss, fallback.pMiss) ?? 0,
	};
}

/** Locate the pool's collapsible interiors in source coordinates. */
function foldIntervals(source, records) {
	const intervals = [];
	for (const record of records) {
		const begin = findBegin(source, record.beginToolCallId);
		const end = findToolCallIndex(source, record.endToolCallId);
		if (!begin || end <= begin.resultIndex || crossesHandoffBoundary(source, begin.resultIndex + 1, end)) continue;
		intervals.push({ record, begin, end });
	}
	return intervals.sort((a, b) => a.begin.assistantIndex - b.begin.assistantIndex);
}

/**
 * Multi-model fold economics. The caller names the target model (`modelKey`)
 * and every still-returnable outer model (`outerModels`, descriptors with
 * { key, spec, pricing }); the popped child is simply absent from the list.
 *
 *   value = A_paid + nHat*pHit*cachedB + (pMiss+(nHat-1)*pHit)*uncachedB
 *   cost  = sum over distinct target+outer caches of (pMiss-pHit) * retained
 *           cached tail tokens
 *   fold  = value > cost   (one comparison, not a per-model AND)
 *
 * Token counts are projected per model from character counts, so no
 * subtraction ever crosses tokenizers. cachedUntilPos is an exclusive
 * message index; a cache counts only while lastUsedAt is inside the TTL.
 */
function shouldFoldPoolMulti({
	pool,
	state,
	base,
	budget,
	pricing,
	contextTokens,
	tokensPerChar = 0.3,
	emergency = false,
	modelKey,
	outerModels,
	now,
}) {
	const records = (Array.isArray(pool) ? pool : []).filter(
		(record) => record && record.collapsed !== true,
	);
	if (records.length === 0) {
		return { fold: false, reason: "empty", mode: "multi-model" };
	}

	const pHit = Number.isFinite(pricing?.pHit) ? Math.max(0, pricing.pHit) : 1e-6;
	const pMiss = Number.isFinite(pricing?.pMiss) ? Math.max(0, pricing.pMiss) : 10e-6;
	const cw = Number.isFinite(pricing?.contextWindow) ? pricing.contextWindow : null;
	const threshold = emergency ? WATERMARK_EMERGENCY : WATERMARK_ECONOMIC;

	let A_paid = 0;
	for (const record of records) {
		A_paid += Number.isFinite(record?.paidRentCost) ? record.paidRentCost : 0;
	}

	if (cw && Number.isFinite(contextTokens) && contextTokens >= threshold * cw) {
		return { fold: true, reason: "watermark", A_paid, pHit, pMiss, mode: "multi-model" };
	}

	const at = Number.isFinite(now) ? now : Date.now();
	const fallbackTpc =
		Number.isFinite(tokensPerChar) && tokensPerChar > 0 ? tokensPerChar : 0.3;

	// Position-exact split of the removable interior against the target
	// cache's cachedUntilPos. Characters are canonical; tokens are projected
	// per model so tokenizers never mix.
	const source = Array.isArray(base) ? base : [];
	const intervals = foldIntervals(source, records);
	const target = cacheView(state, modelKey, at, fallbackTpc);
	const position = Symbol("sourceIndex");
	const start = intervals[0]?.begin.assistantIndex ?? source.length;
	const tagged = source.slice(start).map((message, index) => ({ ...message, [position]: start + index }));
	const epoch = state?.epoch ?? 0;
	let B_pool = 0;
	let cachedB = 0;
	for (const { record, begin, end } of intervals) {
		const recordDensity = record.interiorChars > 0 && record.interiorTokens > 0 ? record.interiorTokens / record.interiorChars : fallbackTpc;
		const density = modelCacheFor(state, modelKey)?.tokensPerChar ?? recordDensity;
		const saved = netRemovableTokens(record, density, modelKey);
		B_pool += saved;
		if (target.pos <= begin.resultIndex || saved === 0) continue;
		if (target.pos >= end) {
			cachedB += saved;
			continue;
		}
		const segment = tagged.slice(begin.assistantIndex - start, end - start + 1);
		const folded = applyCollapses(segment, [{ ...record, collapsed: true }], epoch);
		const removed = Math.max(0, sliceChars(segment) - sliceChars(folded));
		const prefix = (list) => sliceChars(list.filter((message) => message[position] < target.pos));
		if (removed > 0) cachedB += saved * Math.min(1, Math.max(0, prefix(segment) - prefix(folded)) / removed);
	}
	if (!(B_pool > 0)) {
		return { fold: false, reason: "no-savings", A_paid, mode: "multi-model" };
	}
	const uncachedB = Math.max(0, B_pool - cachedB);

	const nHat = budgetSteps(budget);
	const value =
		A_paid +
		nHat * pHit * cachedB +
		(pMiss + (nHat - 1) * pHit) * uncachedB;

	// Cost: every distinct cache among target + still-returnable outer
	// models pays the miss-hit gap once on the retained cached tail. The
	// retained set includes hot workbench content, receipts, users, and pins:
	// everything not marked removed inside each cache's cached prefix.
	const views = new Map();
	views.set(modelKey, {
		key: modelKey,
		pHit,
		pMiss,
		pos: target.pos,
		tpc: target.tpc,
	});
	for (const descriptor of Array.isArray(outerModels) ? outerModels : []) {
		const key = typeof descriptor?.key === "string" ? descriptor.key : null;
		if (!key || views.has(key)) continue;
		const prices = outerPricing(descriptor, { pHit, pMiss });
		const view = cacheView(state, key, at, fallbackTpc);
		views.set(key, {
			key,
			pHit: prices.pHit,
			pMiss: prices.pMiss,
			pos: view.pos,
			tpc: view.tpc,
		});
	}

	const perModel = [];
	let cost = 0;
	const retained = applyCollapses(tagged, intervals.map(({ record }) => ({ ...record, collapsed: true })), epoch);
	for (const view of views.values()) {
		const retainedChars = view.pos <= start ? 0 : sliceChars(retained.filter((message) => message[position] < view.pos));
		const retainedTokens = retainedChars * view.tpc;
		const gap = Math.max(0, view.pMiss - view.pHit);
		const modelCost = gap * retainedTokens;
		cost += modelCost;
		perModel.push({
			key: view.key,
			pHit: view.pHit,
			pMiss: view.pMiss,
			cachedUntilPos: view.pos,
			tokensPerChar: view.tpc,
			retainedCachedTokens: retainedTokens,
			gap,
			cost: modelCost,
		});
	}

	const fold = value > cost;
	return {
		fold,
		reason: fold ? "economics" : "hold",
		B_pool,
		cachedB,
		uncachedB,
		A_paid,
		M_after: null,
		nHat,
		value,
		cost,
		perModel,
		pHit,
		pMiss,
		mode: "multi-model",
	};
}

/**
 * Decide whether a foldable pool should be folded in a single batch.
 * Pure so the economics can be tested without a host session.
 *
 * Multi-model mode activates when `modelKey` names the target model;
 * `outerModels` lists every still-returnable outer model descriptor
 * ({ key, spec, pricing }). Without modelKey the legacy single-model
 * formula runs unchanged.
 */
export function shouldFoldPool({
	pool,
	state,
	base,
	persistedEnd,
	budget,
	usageSnapshot,
	pricing,
	contextTokens,
	tokensPerChar = 0.3,
	emergency = false,
	modelKey = null,
	outerModels = null,
	now = null,
}) {
	const records = Array.isArray(pool) ? pool : [];
	if (records.length === 0) return { fold: false, reason: "empty" };
	if (typeof modelKey === "string" && modelKey !== "") {
		return shouldFoldPoolMulti({
			pool,
			state,
			base,
			budget,
			pricing,
			contextTokens,
			tokensPerChar,
			emergency,
			modelKey,
			outerModels,
			now,
		});
	}
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
 *
 * After a successful physical fold every provider cache is capped at
 * `foldStartIdx` (the first folded begin's assistantIndex): content at or
 * after that index changed, so the cached prefix ends there. foldStartIdx is
 * returned so the station can cap an in-flight usage snapshot too.
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
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1, foldStartIdx: -1 };
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
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1, foldStartIdx: -1 };
	}

	const useEpoch = Number.isInteger(epoch) ? epoch : (state?.epoch ?? 0);
	const tailBefore = source.slice(first.begin.assistantIndex, tailCut);
	const records = valid.map((entry) => entry.record);
	const collapsed = records.map((record) => ({ ...record, collapsed: true }));
	const tailAfter = applyCollapses(tailBefore, collapsed, useEpoch);
	const foldStartIdx = first.begin.assistantIndex;

	if (
		!manager ||
		typeof manager.appendMessage !== "function" ||
		typeof manager.branch !== "function"
	) {
		for (const record of records) record.collapsed = true;
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1, foldStartIdx: -1 };
	}
	try {
		const parentId = beginEntry.parentId ?? null;
		if (parentId) manager.branch(parentId);
		else if (typeof manager.resetLeaf === "function") manager.resetLeaf();
		else throw new Error("resetLeaf unavailable");
		for (const message of tailAfter) {
			if (!appendHistoryMessage(manager, cloneMessage(message))) {
				throw new Error("fold append failed");
			}
		}
	} catch {
		for (const record of records) record.collapsed = true;
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1, foldStartIdx: -1 };
	}

	for (const record of records) record.collapsed = true;
	markSubsumedDescendants(state, records);
	// The fold physically rewrote the branch at foldStartIdx: every provider
	// cache keeps only the prefix before it.
	capCachePositions(state, foldStartIdx);
	const savedChars = Math.max(0, sliceChars(tailBefore) - sliceChars(tailAfter));
	const savedTokens = charsToTokens(savedChars, tokensPerChar);
	const maxOrder = records.reduce(
		(max, record) => (Number.isInteger(record.order) && record.order > max ? record.order : max),
		-1,
	);
	return {
		foldedCount: records.length,
		reports: records.map((record) => record.report),
		savedTokens,
		savedChars,
		maxOrder,
		rebased: true,
		foldStartIdx,
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
