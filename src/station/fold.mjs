/**
 * Station fold: measured interior accounting, pool economics, and single-fork
 * batch folding. Pure host-session manipulation plus pure analysis helpers;
 * no business state lives here.
 */

import {
	applyCollapses,
	collectPinnedMessages,
	filterAmends,
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
import { futureFoldSavings, turnOverheadCost } from "../scope/degradation.mjs";

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
	amends,
	tokensPerChar = 0.3,
) {
	const begin = findBegin(base, beginToolCallId);
	const endIndex = findToolCallIndex(base, endToolCallId);
	if (!begin || endIndex < 0 || endIndex <= begin.resultIndex) {
		return { interiorChars: 0, pinTokens: 0, pinChars: 0, userChars: 0 };
	}
	const slice = filterAmends(
		base.slice(begin.resultIndex + 1, endIndex),
		amends ?? [],
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
 * Local cache estimate for one model key. Messages [0, cachedUntilPos) are
 * eligible under the TTL model; provider usage is the evidence of a hit.
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

/**
 * Per-turn cost that a smaller context cannot shrink: output plus the
 * dialogue delta written to cache. Both averages are measured by the usage
 * ledger; an unknown shape contributes nothing rather than a guessed number.
 */
function nonContextCost(pricing, usageSnapshot) {
	const usage =
		usageSnapshot && typeof usageSnapshot === "object" ? usageSnapshot : null;
	const outputTokens = Number.isFinite(usage?.avgOutput)
		? usage.avgOutput
		: Number.isFinite(usage?.lastOutput)
			? usage.lastOutput
			: 0;
	const turnGrowthTokens = Number.isFinite(usage?.avgTurnGrowth)
		? usage.avgTurnGrowth
		: 0;
	return turnOverheadCost({
		pMiss: pricing?.pMiss,
		pOut: pricing?.pOut,
		outputTokens,
		turnGrowthTokens,
	});
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
	usageSnapshot = null,
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
	const savings = futureFoldSavings({
		nominalWork: nHat,
		poolTokens: B_pool,
		uncachedTokens: uncachedB,
		contextTokens,
		contextWindow: cw,
		pHit,
		pMiss,
		nonContextTurnCost: nonContextCost(pricing, usageSnapshot),
	});
	const value = A_paid + savings.total;

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
		directValue: savings.directValue,
		degradationValue: savings.degradationValue,
		etaKeep: savings.etaKeep,
		etaFold: savings.etaFold,
		nKeep: savings.nKeep,
		nFold: savings.nFold,
		savedTurns: savings.savedTurns,
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
			usageSnapshot,
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
		// The single-model path runs on one tokenizer chain: every record's
		// measured interior was produced by the same model that is reading it.
		// Passing the record's own key keeps that measurement instead of
		// discarding it and re-deriving tokens from characters.
		B_pool += netRemovableTokens(
			record,
			tokensPerChar,
			record.measuredModelKey ?? null,
		);
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
	const savings = futureFoldSavings({
		nominalWork: nHat,
		poolTokens: B_pool,
		uncachedTokens: 0,
		contextTokens,
		contextWindow: cw,
		pHit,
		pMiss,
		nonContextTurnCost: nonContextCost(pricing, usageSnapshot),
	});
	const value = A_paid + savings.total;
	const cost = Math.max(0, pMiss - pHit) * M_after;
	const fold = value > cost;
	return {
		fold,
		reason: fold ? "economics" : "hold",
		B_pool,
		A_paid,
		M_after,
		nHat,
		value,
		cost,
		pHit,
		pMiss,
		directValue: savings.directValue,
		degradationValue: savings.degradationValue,
		etaKeep: savings.etaKeep,
		etaFold: savings.etaFold,
		nKeep: savings.nKeep,
		nFold: savings.nFold,
		savedTurns: savings.savedTurns,
	};
}

/** Persisted tail boundary: a live unpersisted last message is replayed separately. */
function persistedTail(base, currentMessage, currentPersisted) {
	const source = Array.isArray(base) ? base : [];
	if (currentPersisted === false && currentMessage && source[source.length - 1] === currentMessage) {
		return source.length - 1;
	}
	return source.length;
}

function currentLeaf(manager) {
	const value = typeof manager.getLeafId === "function"
		? manager.getLeafId()
		: manager.getBranch()?.at(-1)?.id ?? null;
	if (value !== null && typeof value !== "string") {
		throw new TypeError("The session manager did not provide a valid leaf id.");
	}
	return value;
}

function restoreLeaf(manager, leaf) {
	if (currentLeaf(manager) !== leaf) {
		if (leaf === null) manager.resetLeaf();
		else manager.branch(leaf);
	}
	if (currentLeaf(manager) !== leaf) {
		throw new Error("The session manager did not restore the previous leaf.");
	}
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
	const originalFlags = new Map((batch ?? []).map((record) => [record, record.collapsed]));
	const restoreFlags = () => {
		for (const [record, collapsed] of originalFlags) record.collapsed = collapsed;
	};
	const tailCut = persistedTail(source, currentMessage, currentPersisted);
	const valid = [];
	// A record marked collapsed without a physical fold still disappears from
	// the next outbound list: `applyCollapses` compresses it there. The
	// provider's cached prefix therefore ends at that record's begin, and the
	// ledger has to say so now. Otherwise the economics decision keeps
	// counting cache hits on content that is about to vanish.
	let capAt = Number.POSITIVE_INFINITY;
	const cap = (index) => {
		if (Number.isInteger(index) && index >= 0) capAt = Math.min(capAt, index);
	};
	const flushCap = () => {
		if (Number.isFinite(capAt)) capCachePositions(state, capAt);
	};
	for (const record of batch ?? []) {
		const begin = findBegin(source, record.beginToolCallId);
		const endIndex = findToolCallIndex(source, record.endToolCallId);
		if (!begin || endIndex < 0 || endIndex <= begin.resultIndex) {
			record.collapsed = true;
			continue;
		}
		// A collapse that spans a handoff boundary is skipped by
		// `applyCollapses` too, so its outbound bytes never change.
		if (crossesHandoffBoundary(source, begin.resultIndex + 1, endIndex)) {
			record.collapsed = true;
			continue;
		}
		if (tailCut <= endIndex) {
			// The end message is not persisted yet, so this fold has to wait.
			// The next turn will compress the interior all the same.
			record.collapsed = true;
			cap(begin.assistantIndex);
			continue;
		}
		valid.push({ record, begin, endIndex });
	}
	if (valid.length === 0) {
		flushCap();
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1, foldStartIdx: -1 };
	}

	let first = valid[0];
	let beginEntry = findBeginEntry(manager, first.record.beginToolCallId);
	while (!beginEntry && valid.length > 1) {
		first.record.collapsed = true;
		cap(first.begin.assistantIndex);
		valid.shift();
		first = valid[0];
		beginEntry = findBeginEntry(manager, first.record.beginToolCallId);
	}
	if (!beginEntry) {
		first.record.collapsed = true;
		cap(first.begin.assistantIndex);
		flushCap();
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
		cap(first.begin.assistantIndex);
		flushCap();
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1, foldStartIdx: -1 };
	}
	let previousLeaf;
	try {
		previousLeaf = currentLeaf(manager);
	} catch (error) {
		restoreFlags();
		throw new Error("Cannot fold without a restorable session leaf.", { cause: error });
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
	} catch (error) {
		restoreFlags();
		try {
			restoreLeaf(manager, previousLeaf);
		} catch (rollbackError) {
			const failure = new AggregateError(
				[error, rollbackError],
				"The fold failed and the previous session leaf could not be restored.",
			);
			failure.code = "FOLD_ROLLBACK_FAILED";
			throw failure;
		}
		// Partial writes remain off the active branch. No record or cache
		// cursor changes until the complete folded tail has been written.
		return { foldedCount: 0, savedTokens: 0, rebased: false, maxOrder: -1, foldStartIdx: -1 };
	}

	// Measure the removable interior before marking the records collapsed:
	// netRemovableTokens answers zero for a collapsed record, and the saved
	// amount has to describe what the fold actually took out.
	const measuredSaved = records.reduce(
		(sum, record) =>
			sum +
			netRemovableTokens(
				record,
				tokensPerChar,
				record.measuredModelKey ?? null,
			),
		0,
	);
	for (const record of records) record.collapsed = true;
	markSubsumedDescendants(state, records);
	// The fold physically rewrote the branch at foldStartIdx: every provider
	// cache keeps only the prefix before it. Records marked earlier without a
	// physical fold may sit even further back, so the tightest cap wins.
	cap(foldStartIdx);
	flushCap();
	const savedChars = Math.max(0, sliceChars(tailBefore) - sliceChars(tailAfter));
	const savedTokens =
		measuredSaved > 0
			? measuredSaved
			: charsToTokens(savedChars, tokensPerChar);
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
