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

import { modelCacheFor, touchModelCache } from "./state.mjs";
import { sliceChars, toolCalls } from "../transcript/index.mjs";
import { createHash } from "node:crypto";

const FALLBACK_TOKENS_PER_CHAR = 0.3;
const MIN_TOKENS_PER_CHAR = 0.15;
const MAX_TOKENS_PER_CHAR = 0.8;
// Weight of one fresh sample in the per-turn shape averages. Fast enough to
// follow a model switch, slow enough that a single short turn cannot erase
// the estimate.
const SMOOTH_ALPHA = 0.3;
const SMOOTH_SAMPLES = 8;

function digestText(text) {
	return createHash("sha256").update(text).digest("hex");
}

function headerSummary(header) {
	if (!header || !Array.isArray(header.tools) || header.systemPrompt === undefined) {
		return null;
	}
	const text = JSON.stringify(header);
	return { key: digestText(text), bytes: Buffer.byteLength(text, "utf8") };
}

function extendsMessages(previous, next) {
	if (!Array.isArray(previous) || !Array.isArray(next) || next.length < previous.length) return false;
	return previous.every((hash, index) => hash === next[index]);
}

function smooth(previous, sample, alpha = SMOOTH_ALPHA) {
	if (!Number.isFinite(sample) || sample <= 0) return previous;
	return Number.isFinite(previous)
		? previous * (1 - alpha) + sample * alpha
		: sample;
}

/** Keep only the token counts a pricing policy can read back. */
function tokenFields(snap) {
	return {
		input: snap.input,
		cacheRead: snap.cacheRead,
		cacheWrite: snap.cacheWrite,
		output: snap.output,
	};
}

/**
 * Build one ledger.
 *
 * @param {object} options
 * @param {object} options.state Shared scope state. The ledger reads and
 *   adjusts scope baselines; the station remains the single owner.
 * @param {() => object[]} options.contextMessages Current transcript messages.
 * @param {() => void} options.persist Record the new state in the session.
 * @param {(domain: string, error: unknown) => void} options.noteError
 * @param {(message: object) => string|null} options.modelKeyOf
 * @param {(ctx: object) => object|null} options.actualModelOf
 */
export function createUsageLedger(options) {
	const {
		state,
		contextMessages,
		persist,
		noteError,
		modelKeyOf,
		actualModelOf,
		usage,
		pricing,
	} = options;

	// Host facts arrive as capabilities. Without them the ledger still counts
	// characters and reports no measured watermark, which is what a hostless
	// station did before this module took them as parameters.
	const entryUsage = usage?.entryUsage ?? (() => null);
	const totalInput =
		usage?.totalInput ??
		((snap) =>
			(snap?.input ?? 0) + (snap?.cacheRead ?? 0) + (snap?.cacheWrite ?? 0));
	const usageSnapshot =
		usage?.usageSnapshot ??
		((raw) => ({
			input: raw?.input ?? 0,
			cacheRead: raw?.cacheRead ?? 0,
			cacheWrite: raw?.cacheWrite ?? 0,
			output: raw?.output ?? 0,
			cost: raw?.cost ?? 0,
		}));
	const charsToTokens =
		pricing?.charsToTokens ?? ((chars, ratio) => Math.ceil(chars * ratio));

	const ledger = {
		// Measured usage baseline. Populated from live messages and restored
		// from the branch tail so a session reload (-r) keeps the watermark.
		lastTotalInput: null,
		lastOutputTokens: 0,
		lastUsageCost: null,
		lastCtxModel: null,
		lastUsageModelKey: null,
		// The raw payload that produced `lastUsageCost`. `pricingHint` hands
		// it back to `policyFromUsage`, which needs the token counts as much
		// as the charge: a cost alone cannot derive a unit price.
		lastUsageSnapshot: null,
		// Smoothed per-turn shape. Without these the non-context part of a
		// turn is zero, and degradation rent only counts the cache re-read.
		avgOutputTokens: null,
		avgTurnGrowthTokens: null,
		received: new WeakSet(),
		sentContext: null,
		contextRevision: 0,
		lastHeader: null,
		fixedHeaderKeys: new Map(),
		// A slope sample is usable only while the message prefix and complete
		// request header remain unchanged. Length growth alone is not proof:
		// an amend or a rewritten prefix can still leave a longer transcript.
		lastSample: null,
		// Models whose density already came from a slope sample. The first
		// slope replaces the ratio-based guess outright; averaging a clean
		// measurement with a number that is wrong by 2.5x would only halve the
		// error, so smoothing starts with the second sample.
		slopeKeys: new Set(),
	};

	/** Record one prepared request without retaining its message bodies. */
	function noteSentContext({ key, messages, frontier, header }) {
		ledger.sentContext = null;
		ledger.lastHeader = null;
		const source = Array.isArray(messages) ? messages : [];
		const head = headerSummary(header);
		ledger.lastHeader = head;
		ledger.sentContext = {
			key,
			chars: sliceChars(source),
			frontier: Number.isInteger(frontier) ? frontier : source.length,
			revision: ledger.contextRevision,
			epoch: state.epoch ?? 0,
			headerKey: head?.key ?? null,
			messageHashes: source.map(digest),
		};
	}

	/** Recover the most recent usage from the persisted branch tail. */
	function restoreFromBranch(manager) {
		try {
			const branch = manager?.getBranch?.();
			if (!Array.isArray(branch)) return;
			const samples = [];
			for (let index = branch.length - 1; index >= 0; index -= 1) {
				const entry = branch[index];
				const usage = entryUsage(entry);
				if (!usage) continue;
				samples.push({ entry, usage, snap: usageSnapshot(usage) });
				if (samples.length >= SMOOTH_SAMPLES) break;
			}
			if (samples.length === 0) return;
			const latest = samples[0];
			const tIn = totalInput(latest.snap);
			ledger.lastTotalInput = tIn;
			ledger.lastUsageModelKey = modelKeyOf(latest.entry?.message);
			ledger.lastOutputTokens = latest.snap.output;
			ledger.lastUsageCost = latest.usage.cost ?? null;
			ledger.lastUsageSnapshot = tokenFields(latest.snap);
			// Warm the output average oldest-first so a reloaded session
			// enters its first fold decision with the same shape a live one
			// learned, instead of treating output as free.
			for (const sample of samples.slice().reverse()) {
				ledger.avgOutputTokens = smooth(
					ledger.avgOutputTokens,
					sample.snap.output,
				);
			}
			// Receipt projection owns baselines now; a restored branch reads its
			// usage snapshot and derives them from the live request.
		} catch (error) {
			// A host without a branch keeps the null baseline. The loss is
			// recorded because every later scope baseline then starts from the
			// wrong number, which shows up as impossible turn arithmetic.
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
			if (tIn <= 0) {
				// Host gates emit zero-usage assistant messages without a model
				// call. They cannot replace a measured context or refresh a cache.
				ledger.sentContext = null;
				ledger.lastSample = null;
				// Preserve a real reported output charge if a provider omitted
				// input usage. It supplies no input-density measurement either.
				if (snap.output > 0 || snap.cost > 0) {
					ledger.lastOutputTokens += Math.max(0, snap.output);
					ledger.lastUsageCost = message.usage.cost ?? null;
				}
				return;
			}
			const live = actualModelOf(ctx) ?? ledger.lastCtxModel;
			const key = message.provider
				? modelKeyOf(message)
				: (modelKeyOf(live) ?? modelKeyOf(message));
			ledger.lastUsageModelKey = key;
			ledger.lastTotalInput = tIn;
			ledger.lastOutputTokens = snap.output;
			ledger.lastUsageCost = message.usage.cost ?? null;
			ledger.lastUsageSnapshot = tokenFields(snap);
			// Output arrives on every measured turn, cached or not, so this
			// average needs no alignment proof.
			ledger.avgOutputTokens = smooth(ledger.avgOutputTokens, snap.output);
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
				// These are local request estimates. They do not prove which
				// tokens the provider retained or read from its own cache.
				const aligned = sent?.key === key &&
					(sent.revision === undefined || sent.revision === ledger.contextRevision) &&
					(sent.epoch === undefined || sent.epoch === (state.epoch ?? 0));
				const measured = aligned && Number.isFinite(sent.chars) ? sent.chars : null;
				const chars =
					measured ??
					sliceChars(index < 0 ? messages : messages.slice(0, index));
				ledger.sentContext = null;
				const previous = modelCacheFor(state, key);
				const prior = ledger.lastSample;
				let density = previous?.tokensPerChar;
				// A stable header and an unchanged prior message prefix are
				// required before input growth can estimate dialogue density.
				// Missing header evidence disables this sample; it is not an
				// implicit assertion that the header stayed the same.
				if (
					prior &&
					prior.key === key &&
					prior.sent === true &&
					measured !== null &&
					typeof sent.headerKey === "string" &&
					prior.headerKey === sent.headerKey &&
					prior.revision === sent.revision &&
					prior.epoch === sent.epoch &&
					extendsMessages(prior.messageHashes, sent.messageHashes) &&
					measured > prior.chars &&
					tIn > prior.totalInput
				) {
					const slope =
						(tIn - prior.totalInput) / (measured - prior.chars);
					if (Number.isFinite(slope) && slope > 0) {
						// The same aligned delta measures how many tokens one
						// turn appends to the context. That growth is written
						// to the cache once, so it is part of every extra
						// turn a bloated context forces.
						ledger.avgTurnGrowthTokens = smooth(
							ledger.avgTurnGrowthTokens,
							tIn - prior.totalInput,
						);
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
					headerKey: sent?.headerKey ?? null,
					revision: sent?.revision,
					epoch: sent?.epoch,
					messageHashes: sent?.messageHashes,
				};
				if (measured !== null && sent.headerKey) {
					ledger.fixedHeaderKeys.set(key, sent.headerKey);
				}
				touchModelCache(state, key, {
					cachedUntilPos:
						aligned ? Math.min(frontier, sent.frontier) : frontier,
					lastUsedAt: Date.now(),
					tokensPerChar: density,
					// Estimate the fixed portion only from an aligned request.
					// Its accuracy still depends on the sampled token density.
					fixedOverheadTokens:
						measured !== null && chars > 0 && tIn > 0
							? Math.max(0, tIn - chars * density)
							: (previous?.fixedOverheadTokens ?? null),
				});
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

	/** Estimate a complete projection without using a pre-rewrite watermark. */
	function projectContextTokens(messages, key = ledger.lastUsageModelKey) {
		const source = Array.isArray(messages) ? messages : contextMessages();
		const cached = modelCacheFor(state, key);
		const header = ledger.lastHeader;
		let fixed;
		if (
			Number.isFinite(cached?.fixedOverheadTokens) &&
			(!header || ledger.fixedHeaderKeys.get(key) === header.key)
		) {
			fixed = Math.max(0, cached.fixedOverheadTokens);
		} else if (header) {
			// Without a sample for this tokenizer, charge the observed header's
			// UTF-8 byte count instead of inventing a token constant or charging
			// zero. This is a conservative text estimate, not an exact tokenizer.
			fixed = header.bytes;
		} else {
			// The caller must treat an unknown complete request as unmeasured.
			return Number.POSITIVE_INFINITY;
		}
		return fixed + charsToTokens(sliceChars(source), tokensPerCharFor(key));
	}

	/** Live outbound watermark from the last usage plus pending messages. */
	function currentContextTokens(messages, key = ledger.lastUsageModelKey) {
		const source = Array.isArray(messages) ? messages : contextMessages();
		const tpc = tokensPerCharFor(key);
		if (
			!Number.isFinite(ledger.lastTotalInput) ||
			(key && key !== ledger.lastUsageModelKey)
		) {
			return projectContextTokens(source, key);
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
		if (!ledger.lastUsageCost) return undefined;
		return {
			usage: {
				...(ledger.lastUsageSnapshot ?? {}),
				cost: ledger.lastUsageCost,
			},
		};
	}

	function resetWatermark() {
		ledger.lastTotalInput = null;
		ledger.lastOutputTokens = 0;
		ledger.contextRevision += 1;
		ledger.sentContext = null;
		ledger.lastSample = null;
	}

	/** After a fold, shift younger baselines down by the reclaimed tokens. */
	function rebase(folded) {
		if (!folded) return;
		ledger.contextRevision += 1;
		ledger.sentContext = null;
		ledger.lastSample = null;
		if (
			typeof folded.savedTokens !== "number" ||
			folded.savedTokens <= 0
		) {
			return;
		}
		// A batch can contain records measured by several tokenizers. Rebase
		// this ledger in its own model's units when the removed text is known.
		const saved = Number.isFinite(folded.savedChars)
			? charsToTokens(Math.max(0, folded.savedChars), tokensPerCharFor(ledger.lastUsageModelKey))
			: folded.savedTokens;
		if (Number.isFinite(ledger.lastTotalInput)) {
			ledger.lastTotalInput = Math.max(0, ledger.lastTotalInput - saved);
		}
	}

	return Object.assign(ledger, {
		noteSentContext,
		restoreFromBranch,
		onMessage,
		tokensPerChar,
		tokensPerCharFor,
		currentContextTokens,
		projectContextTokens,
		usageArrivedFor,
		pricingHint,
		resetWatermark,
		rebase,
	});
}
