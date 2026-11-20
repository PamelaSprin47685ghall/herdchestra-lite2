// Usage ledger: measured watermarks, cache rent, and fold triggers.
//
// A station owns scope and relay state. The measured usage facts are a
// different secret: the last provider payload, the live context watermark,
// and the per-model cache density. They change for different reasons and
// evolve on different evidence, so they live here instead of inside the
// station.
//
// This module is a plain synchronous domain object. It is not a station: no
// host event reaches it, it awaits nothing, and it holds no ticket table. The
// station owns one ledger and passes it the callbacks it cannot import
// without inverting a dependency.

import { findActivePools } from "./accounting.mjs";
import { modelCacheFor, touchModelCache } from "./state.mjs";
import { entryUsage, totalInput, usageSnapshot } from "../host/usage.mjs";
import { charsToTokens } from "../host/pricing.mjs";
import { toolCalls } from "../transcript/index.mjs";

const FALLBACK_TOKENS_PER_CHAR = 0.3;
const MIN_TOKENS_PER_CHAR = 0.15;
const MAX_TOKENS_PER_CHAR = 0.8;

/**
 * Build one ledger.
 *
 * @param {object} options
 * @param {object} options.state Shared scope state. The ledger reads and
 *   adjusts scope baselines; the station remains the single owner.
 * @param {() => object[]} options.contextMessages Current transcript messages.
 * @param {() => void} options.persist Record the new state in the session.
 * @param {(args: object) => object} options.foldBatch Fold a pool batch.
 * @param {(domain: string, error: unknown) => void} options.noteError
 * @param {(messages: object[]) => number} options.sliceChars Character weight.
 * @param {(record: object, tpc: number, key: string|null) => number}
 *   options.netRemovableTokens Tokens a collapse can still reclaim.
 * @param {(message: object) => string|null} options.modelKeyOf
 * @param {(ctx: object) => object|null} options.actualModelOf
 */
export function createUsageLedger(options) {
	const {
		state,
		contextMessages,
		persist,
		foldBatch,
		noteError,
		sliceChars,
		netRemovableTokens,
		modelKeyOf,
		actualModelOf,
	} = options;

	const ledger = {
		// Measured usage baseline. Populated from live messages and restored
		// from the branch tail so a session reload (-r) keeps the watermark.
		lastTotalInput: null,
		lastOutputTokens: 0,
		lastUsageCost: null,
		lastCtxModel: null,
		lastUsageModelKey: null,
		received: new WeakSet(),
		sentContext: null,
		// Previous outbound sample for the incremental density estimate:
		// { key, chars, totalInput, sent }. The difference between two
		// samples cancels the system prompt and tool schemas exactly, which
		// is the only way to measure the dialogue's own density.
		lastSample: null,
		// Models whose density already came from a slope sample. The first
		// slope replaces the ratio-based guess outright; averaging a clean
		// measurement with a number that is wrong by 2.5x would only halve the
		// error, so smoothing starts with the second sample.
		slopeKeys: new Set(),
	};

	/** Recover the most recent usage from the persisted branch tail. */
	function restoreFromBranch(manager) {
		try {
			const branch = manager?.getBranch?.();
			if (!Array.isArray(branch)) return;
			for (let index = branch.length - 1; index >= 0; index -= 1) {
				const entry = branch[index];
				const message = entry?.message;
				const usage = entryUsage(entry);
				if (!usage) continue;
				const snap = usageSnapshot(usage);
				const tIn = totalInput(snap);
				ledger.lastTotalInput = tIn;
				ledger.lastUsageModelKey = modelKeyOf(message);
				ledger.lastOutputTokens = snap.output;
				ledger.lastUsageCost = usage.cost ?? null;
				for (const scope of state.scopes ?? []) {
					if (
						scope.baseInputTokens === null ||
						scope.baseInputTokens === undefined
					) {
						scope.baseInputTokens = tIn;
						scope.baseModelKey = ledger.lastUsageModelKey;
					}
				}
				break;
			}
		} catch (error) {
			// A host without a branch keeps the null baseline. The loss is
			// recorded because every later scope baseline then starts from the
			// wrong number, which shows up as impossible budget arithmetic.
			noteError("usage", error);
		}
	}

	/**
	 * Fold one assistant usage payload into the live baseline. Idempotent per
	 * message object.
	 */
	function onMessage(message, ctx) {
		if (!message || message.role !== "assistant") return;
		try {
			if (!message.usage || ledger.received.has(message)) return;
			ledger.received.add(message);
			const snap = usageSnapshot(message.usage);
			const tIn = totalInput(snap);
			const live = actualModelOf(ctx) ?? ledger.lastCtxModel;
			const key = message.provider
				? modelKeyOf(message)
				: (modelKeyOf(live) ?? modelKeyOf(message));
			ledger.lastUsageModelKey = key;
			ledger.lastTotalInput = tIn;
			ledger.lastOutputTokens = snap.output;
			ledger.lastUsageCost = message.usage.cost ?? null;
			if (key) {
				const messages = contextMessages();
				const index = messages.findLastIndex(
					(item) =>
						item === message ||
						(item?.role === "assistant" &&
							message.timestamp != null &&
							item.timestamp === message.timestamp &&
							(modelKeyOf(item) ?? key) === key),
				);
				const sent = ledger.sentContext;
				const frontier = index < 0 ? messages.length : index;
				// `chars` is the dialogue weight of the payload this usage
				// answers. A sent record with the same key names it exactly;
				// otherwise the message prefix is the best available estimate.
				const measured = sent?.key === key ? sent.chars : null;
				const chars =
					measured ??
					sliceChars(index < 0 ? messages : messages.slice(0, index));
				ledger.sentContext = null;
				const previous = modelCacheFor(state, key);
				const prior = ledger.lastSample;
				let density = previous?.tokensPerChar;
				// Incremental slope: system prompt and tool schemas are the
				// same in both payloads, so their tokens cancel in the
				// difference and only dialogue text remains. Both samples must
				// be same-model, sent-context aligned, and monotone: a fold or
				// an amend shrinks the outbound list and voids the sample.
				if (
					prior &&
					prior.key === key &&
					prior.sent === true &&
					measured !== null &&
					measured > prior.chars &&
					tIn > prior.totalInput
				) {
					const slope =
						(tIn - prior.totalInput) / (measured - prior.chars);
					if (Number.isFinite(slope) && slope > 0) {
						const sample = Math.min(
							MAX_TOKENS_PER_CHAR,
							Math.max(MIN_TOKENS_PER_CHAR, slope),
						);
						if (ledger.slopeKeys.has(key)) {
							density =
								Number.isFinite(density) && density > 0
									? density * 0.5 + sample * 0.5
									: sample;
						} else {
							density = sample;
							ledger.slopeKeys.add(key);
						}
					}
				}
				if (!Number.isFinite(density) || density <= 0) {
					density =
						chars > 0 && tIn > 0
							? Math.min(
									MAX_TOKENS_PER_CHAR,
									Math.max(MIN_TOKENS_PER_CHAR, tIn / chars),
								)
							: FALLBACK_TOKENS_PER_CHAR;
				}
				ledger.lastSample = {
					key,
					chars,
					totalInput: tIn,
					sent: measured !== null,
				};
				touchModelCache(state, key, {
					cachedUntilPos:
						sent?.key === key ? Math.min(frontier, sent.frontier) : frontier,
					lastUsedAt: Date.now(),
					tokensPerChar: density,
					// Everything the payload paid that no dialogue character
					// explains: the system prompt and tool schemas. Recorded
					// per model so a later model switch can project the same
					// fixed cost instead of pretending it vanished.
					fixedOverheadTokens:
						chars > 0 && tIn > 0
							? Math.max(0, tIn - chars * density)
							: (previous?.fixedOverheadTokens ?? null),
				});
			}
			const callIds = new Set(toolCalls(message).map((call) => call.id));
			for (const scope of state.scopes ?? []) {
				if (callIds.has(scope.beginToolCallId)) continue;
				if (
					scope.baseInputTokens === null ||
					scope.baseInputTokens === undefined
				) {
					scope.baseInputTokens = tIn;
					scope.baseModelKey = key;
				}
			}
			// A tool_call may close a scope before its assistant usage arrives.
			// Complete the deferred measured interior once usage is visible.
			const collapses = state.collapses ?? [];
			for (let index = collapses.length - 1; index >= 0; index -= 1) {
				const record = collapses[index];
				if (record.endInputTokensPending !== true) continue;
				if (!callIds.has(record.endToolCallId)) continue;
				record.endInputTokens = tIn;
				const base = record.baseInputTokens;
				record.measuredModelKey = key;
				record.interiorTokens =
					key && typeof base === "number" && record.baseModelKey === key
						? Math.max(0, tIn - base)
						: Number.isFinite(record.interiorChars)
							? Math.ceil(
									charsToTokens(record.interiorChars, tokensPerCharFor(key)),
								)
							: null;
				record.endInputTokensPending = false;
				for (const scope of state.scopes ?? []) {
					if (
						scope.preBeginInputTokens === null ||
						scope.preBeginInputTokens === undefined
					) {
						scope.preBeginInputTokens = tIn;
					}
				}
			}
			persist();
		} catch (error) {
			noteError("usage", error);
		}
	}

	/** Observed token density, clamped to a safe band. */
	function tokensPerChar(messages) {
		// The ratio of total input to dialogue characters is not a density: it
		// also contains the system prompt and tool schemas, which is a large
		// constant and drove this value to the clamp ceiling in every real
		// session. Only the per-model incremental sample measures dialogue.
		const key = ledger.lastUsageModelKey;
		const cached = key ? modelCacheFor(state, key)?.tokensPerChar : null;
		if (Number.isFinite(cached) && cached > 0) return cached;
		const sample = ledger.lastSample;
		if (sample && Number.isFinite(sample.chars) && sample.chars > 0) {
			const rate = sample.totalInput / sample.chars;
			if (Number.isFinite(rate) && rate > 0) {
				return Math.min(
					MAX_TOKENS_PER_CHAR,
					Math.max(MIN_TOKENS_PER_CHAR, rate),
				);
			}
		}
		void messages;
		return FALLBACK_TOKENS_PER_CHAR;
	}

	function tokensPerCharFor(key) {
		return key
			? (modelCacheFor(state, key)?.tokensPerChar ?? FALLBACK_TOKENS_PER_CHAR)
			: tokensPerChar();
	}

	/** Live outbound watermark from the last usage plus pending messages. */
	function currentContextTokens(messages, key = ledger.lastUsageModelKey) {
		const source = Array.isArray(messages) ? messages : contextMessages();
		const tpc = tokensPerCharFor(key);
		if (
			!Number.isFinite(ledger.lastTotalInput) ||
			(key && key !== ledger.lastUsageModelKey)
		) {
			// A model switch has no measured payload for this transcript. The
			// projection must still pay the constant prefix (system prompt and
			// tool schemas), which is per model and never zero in practice.
			const fixed = Number.isFinite(modelCacheFor(state, key)?.fixedOverheadTokens)
				? Math.max(0, modelCacheFor(state, key).fixedOverheadTokens)
				: 0;
			return fixed + charsToTokens(sliceChars(source), tpc);
		}
		let pendingChars = 0;
		let usageIndex = -1;
		for (let index = 0; index < source.length; index += 1) {
			if (source[index]?.role === "assistant" && source[index]?.usage) {
				usageIndex = index;
			}
		}
		for (let index = usageIndex + 1; index < source.length; index += 1) {
			if (source[index]?.role === "custom") continue;
			pendingChars += sliceChars([source[index]]);
		}
		return (
			ledger.lastTotalInput +
			(Number.isFinite(ledger.lastOutputTokens)
				? ledger.lastOutputTokens
				: 0) +
			charsToTokens(pendingChars, tpc)
		);
	}

	/** True when a message already carries the usage that closes a scope. */
	function usageArrivedFor(message) {
		return Boolean(message?.usage) || ledger.received.has(message);
	}

	function pricingHint() {
		return ledger.lastUsageCost
			? { usage: { cost: ledger.lastUsageCost } }
			: undefined;
	}

	function resetWatermark() {
		ledger.lastTotalInput = null;
		ledger.lastOutputTokens = 0;
		if (ledger.sentContext) ledger.sentContext.frontier = 0;
	}

	/** After a fold, shift younger baselines down by the reclaimed tokens. */
	function rebase(folded) {
		if (
			!folded ||
			typeof folded.savedTokens !== "number" ||
			folded.savedTokens <= 0
		) {
			return;
		}
		const saved = folded.savedTokens;
		for (const scope of state.scopes ?? []) {
			const orderMatch = /^scope-(\d+)$/.exec(String(scope.id ?? ""));
			const order = orderMatch ? Number(orderMatch[1]) : 0;
			if (Number.isInteger(folded.maxOrder) && order <= folded.maxOrder) {
				continue;
			}
			if (
				ledger.lastUsageModelKey &&
				scope.baseModelKey === ledger.lastUsageModelKey &&
				Number.isFinite(scope.baseInputTokens)
			) {
				scope.baseInputTokens = Math.max(0, scope.baseInputTokens - saved);
			}
		}
		// The hot workbench is not an open scope: it is a closed record whose
		// begin still stands after the fold. Its base was measured before the
		// reclaimed bytes disappeared, so it has to move down with the branch.
		// Without this, the next fold of that record computes
		// `lastTotalInput - baseInputTokens` against a base that still counts
		// the previous fold's content, and M_after collapses towards zero.
		for (const record of state.collapses ?? []) {
			if (!record || record.collapsed !== false) continue;
			if (
				Number.isInteger(folded.maxOrder) &&
				Number.isInteger(record.order) &&
				record.order <= folded.maxOrder
			) {
				continue;
			}
			if (
				ledger.lastUsageModelKey &&
				record.baseModelKey === ledger.lastUsageModelKey
			) {
				if (Number.isFinite(record.baseInputTokens)) {
					record.baseInputTokens = Math.max(0, record.baseInputTokens - saved);
				}
				if (Number.isFinite(record.preBeginInputTokens)) {
					record.preBeginInputTokens = Math.max(
						0,
						record.preBeginInputTokens - saved,
					);
				}
			}
			if (Number.isFinite(record.endInputTokens)) {
				record.endInputTokens = Math.max(0, record.endInputTokens - saved);
			}
		}
		if (Number.isFinite(ledger.lastTotalInput)) {
			ledger.lastTotalInput = Math.max(0, ledger.lastTotalInput - saved);
		}
	}

	/** Accrue per-step cache rent and flood the pools at the 90% watermark. */
	function accrue(original, pricing, contextTokens, key) {
		const pools = findActivePools(state);
		if (pools.length === 0) return false;
		const tpc = tokensPerCharFor(key);
		const pHit = Number.isFinite(pricing?.pHit) ? Math.max(0, pricing.pHit) : 1e-6;
		let dirty = false;
		for (const group of pools) {
			for (const record of group.pool) {
				const rent = netRemovableTokens(record, tpc, key) * pHit;
				if (rent > 0) {
					record.paidRentCost =
						(Number.isFinite(record.paidRentCost) ? record.paidRentCost : 0) +
						rent;
					dirty = true;
				}
			}
		}
		const cw = Number.isFinite(pricing?.contextWindow)
			? pricing.contextWindow
			: null;
		const emergency =
			cw && Number.isFinite(contextTokens) && contextTokens >= 0.9 * cw;
		if (emergency) {
			// Always fold against the persisted tree. `original` is the live
			// message array and may carry an unpushed tail, so slicing it and
			// writing the result back to the branch would splice history the
			// SessionManager never held.
			void original;
			const tree = contextMessages();
			const batch = pools
				.flatMap(({ pool }) => pool)
				.sort((a, b) => a.order - b.order);
			const folded = foldBatch({
				batch,
				base: tree,
				epoch: state.epoch,
			});
			if (folded.rebased) {
				rebase(folded);
				dirty = true;
			}
		}
		if (dirty) persist();
		return dirty;
	}

	return Object.assign(ledger, {
		restoreFromBranch,
		onMessage,
		tokensPerChar,
		tokensPerCharFor,
		currentContextTokens,
		usageArrivedFor,
		pricingHint,
		resetWatermark,
		rebase,
		accrue,
	});
}
