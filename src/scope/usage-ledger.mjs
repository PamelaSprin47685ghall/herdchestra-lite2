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
import { messageChars, prefixChars, sliceChars, toolCalls } from "../transcript/index.mjs";
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

// -- Message fingerprints -----------------------------------------------------
//
// A fingerprint must follow an in-place edit: the same message object can have
// a block rewritten between two requests, and the slope sample relies on the
// change showing up. So a digest cannot be cached by object identity alone —
// that was tried and the tests below pin the failure.
//
// It also must not re-serialize every message on every request. The request
// carries the whole transcript, so one request costs a full read of every
// message body and a session costs the square of its own size; that is the
// stall this memo removes.
//
// The memo answers the same question for a pointer walk. For each message it
// keeps the *shape* of the value it hashed: every node of the walk, containing
// containers by identity and primitives by value. Strings and numbers are
// immutable, so a shape that still matches proves the message still serializes
// to the same text; a shape that no longer matches forces a real re-serialize,
// and only for that message. Detection stays complete — every edit that could
// change the digest changes some node — while an ordinary turn pays tens of
// comparisons instead of reading megabytes.
//
// Only plain objects and arrays are memoized. Any other prototype (a Date, a
// class instance) may carry state behind `toJSON` or an accessor, so a message
// holding one is recomputed every time and never memoized.

const MESSAGE_MEMO = new WeakMap();

function isPlainValue(value) {
	if (value === null || typeof value !== "object") return true;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null || proto === Array.prototype;
}

// A shape is the pre-order walk of one message, one node at a time:
//
//   primitive     → [value]
//   plain array   → [array, length, keys, ...children]
//   plain object  → [object, keys, ...children]
//
// The digest is `JSON.stringify`'s text, so only what that text exposes may
// enter the shape — and the memo proves this node's text unchanged by proving
// the inputs it was built from unchanged:
//
//   * the own *enumerable* keys in order, because that is the text;
//   * an array's `length`, which is not one of its keys — a trailing hole
//     emits a `null` while the key list stays the same;
//   * an accessor, which is user code, so a message that carries one is never
//     memoized (see `buildShape`).
//
// A non-enumerable own property is deliberately ignored: `JSON.stringify` does
// not serialize it, so it cannot move the digest this memo stands for. The
// character count is not memoized either (it is recomputed by `sliceChars` on
// every request, which is what keeps its read order and its view of hidden
// properties exactly as they were before the memo existed), so nothing here
// needs to watch properties the digest cannot see. Watching them would cost a
// second own-name array per node — one third of the walk's allocations — to
// learn something the digest does not depend on.
//
// `Array.isArray` at match time tells the two bins apart. A walk deeper than
// `MAX_SHAPE_DEPTH` is refused, which keeps a cyclic message out of the
// recursion; the digest call then throws on it exactly as it did before,
// instead of overflowing the stack.
const MAX_SHAPE_DEPTH = 32;

/**
 * Would `JSON.stringify` replace this value through a `toJSON` property?
 *
 * Only a callable `toJSON` is called, and an accessor could answer with one, so
 * an accessor counts as a hazard too. The descriptor is the witness: it neither
 * calls nor reads anything. A hazard means the text does not follow from the
 * keys alone, so the message is not memoized.
 */
function toJSONHazard(descriptor) {
	if (descriptor === undefined) return false;
	if (descriptor.get !== undefined || descriptor.set !== undefined) return true;
	return typeof descriptor.value === "function";
}

/**
 * Would `JSON.stringify` find a `toJSON` above this value?
 *
 * `isPlainValue` admits exactly three prototypes — `Object.prototype`, `null`
 * and `Array.prototype` — so the chain is at most two links: an array reaches
 * `Array.prototype` and then `Object.prototype`, an ordinary object reaches
 * `Object.prototype`, and a null-prototype object reaches nothing. Every link
 * is checked, because a patch to `Object.prototype` is inherited by arrays and
 * would change an array node's text with its keys untouched.
 *
 * Descriptors only, and no `value.toJSON`: reading that would run a
 * `get toJSON()` the serialization has not asked for yet, and a null prototype
 * has nothing to read from in the first place.
 */
function inheritedToJSONHazard(value) {
	let proto = Object.getPrototypeOf(value);
	while (proto !== null) {
		if (toJSONHazard(Object.getOwnPropertyDescriptor(proto, "toJSON"))) return true;
		// `Object.prototype` is the last link `isPlainValue` admits; stopping
		// here keeps the walk from leaving the plain-object world.
		if (proto === Object.prototype) return false;
		proto = Object.getPrototypeOf(proto);
	}
	return false;
}

function buildShape(value, out, depth = 0) {
	if (value === null || typeof value !== "object") {
		out.push(value);
		return true;
	}
	if (depth > MAX_SHAPE_DEPTH) return false;
	if (!isPlainValue(value)) return false;
	const keys = Object.keys(value);
	const isArray = Array.isArray(value);
	// An accessor is refused, because reading it is user code that the walk
	// cannot assume inert: it may answer differently on every call, and it may
	// change a field the walk has already passed — which would leave a shape
	// whose stored nodes no longer describe the text that was hashed. The cost
	// of refusal is one re-serialize per request, which is what this memo
	// replaced, so a refused message is never slower than before the memo.
	for (let index = 0; index < keys.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
		if (descriptor === undefined) return false;
		if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
	}
	// `JSON.stringify` replaces a value whose `toJSON` answers, so the digest
	// would hold that answer and the shape would hold the function. Both the
	// own and the inherited lookup go through descriptors, never through
	// `value.toJSON`: a `get toJSON()` is user code, and reading it here would
	// run it once more than the serialization does.
	if (toJSONHazard(Object.getOwnPropertyDescriptor(value, "toJSON"))) return false;
	if (inheritedToJSONHazard(value)) return false;
	out.push(value);
	if (isArray) {
		// A name beyond the keys and `length` is an index `Object.keys` hides
		// while `JSON.stringify` still serializes it, and this walk visits
		// children through `keys` alone — so its subtree would never be
		// compared. Refusing is the only exact answer. The count is then stored
		// so a hidden index *added later* is noticed at match time.
		const ownCount = Object.getOwnPropertyNames(value).length;
		if (ownCount !== keys.length + 1) return false;
		out.push(value.length);
		out.push(ownCount);
	}
	out.push(keys);
	for (let index = 0; index < keys.length; index += 1) {
		if (!buildShape(value[keys[index]], out, depth + 1)) return false;
	}
	return true;
}

/** Walk `value` against a stored shape; -1 means the shape no longer holds. */
function matchShape(value, shape, cursor) {
	if (shape[cursor] !== value) return -1;
	cursor += 1;
	if (value === null || typeof value !== "object") return cursor;
	if (!isPlainValue(value)) return -1;
	// A `toJSON` inherited from a prototype rewrites this node's text without
	// changing one key, and it can be installed after the shape was built — a
	// patched `Object.prototype` then makes every cached digest stale at once,
	// array nodes included, since they inherit from it too. The descriptor
	// witnesses that without calling anything.
	if (inheritedToJSONHazard(value)) return -1;
	const isArray = Array.isArray(value);
	if (isArray) {
		if (value.length !== shape[cursor]) return -1;
		cursor += 1;
		// The hidden index this compares is serialized by `JSON.stringify`
		// without being a key (see `buildShape`).
		if (Object.getOwnPropertyNames(value).length !== shape[cursor]) return -1;
		cursor += 1;
	} else if (Object.getOwnPropertyDescriptor(value, "toJSON") !== undefined) {
		// `buildShape` refuses an own `toJSON`, so a message that reaches here had
		// none. One added since is invisible to `Object.keys` when it is
		// non-enumerable, and the digest still belongs to `JSON.stringify`'s text
		// — which now calls that function. The descriptor is the cheap witness:
		// no call, no array allocated, and it sees a hidden property.
		return -1;
	}
	const keys = shape[cursor];
	cursor += 1;
	// Same key set, same order: an added, dropped or renamed key changes the
	// serialized text, and every other edit changes a child reference.
	const own = Object.keys(value);
	if (own.length !== keys.length) return -1;
	for (let index = 0; index < own.length; index += 1) {
		if (own[index] !== keys[index]) return -1;
	}
	// Each child is read through its own descriptor, never through `value[key]`.
	// A property that was data when the shape was built can be replaced by an
	// accessor afterwards, and an accessor is user code: reading it during a
	// comparison would run it a second time per request — a side effect the
	// caller never asked for, in an order the serialization cannot explain. A
	// descriptor answers "data or accessor" and carries the data value itself,
	// so this walk is inert: it observes, and it never executes anything.
	for (let index = 0; index < keys.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
		if (descriptor === undefined) return -1;
		if (descriptor.get !== undefined || descriptor.set !== undefined) return -1;
		cursor = matchShape(descriptor.value, shape, cursor);
		if (cursor < 0) return -1;
	}
	return cursor;
}

/**
 * Fingerprint one message: its digest.
 *
 * The digest is the only thing memoized. The payable characters are counted by
 * `sliceChars` over the whole sequence, in its own pass, because that pass is
 * not inert: `sliceChars` stringifies tool-call arguments, and any accessor in a
 * message runs there. Keeping the count out of this function keeps the two pass
 * order the code always had, and a memo hit reads no message text.
 */
function fingerprintMessage(message) {
	const memo = message !== null && typeof message === "object"
		? MESSAGE_MEMO.get(message)
		: undefined;
	if (memo && matchShape(message, memo.shape, 0) === memo.shape.length) {
		return memo;
	}
	const shape = [];
	const memoizable = isPlainValue(message) && buildShape(message, shape);
	const entry = {
		hash: digestText(JSON.stringify(message) ?? "null"),
		shape: memoizable ? shape : null,
	};
	if (memoizable) MESSAGE_MEMO.set(message, entry);
	else if (message !== null && typeof message === "object") MESSAGE_MEMO.delete(message);
	return entry;
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
		// The count runs first, over the whole sequence, exactly as it did before
		// the fingerprints were memoized. Its reads are not inert — a tool call's
		// arguments are stringified here, and any accessor a message carries runs
		// here — so keeping its place preserves both the values and the order in
		// which a side effect happens. The memo covers the digest alone, which is
		// where the bytes are.
		const chars = sliceChars(source);
		const messageHashes = source.map((message) => fingerprintMessage(message).hash);
		// The fingerprints are always computed. Skipping them was tried and
		// reverted: a request that skips them still becomes the next sample's
		// `prior`, so the null list outlives the condition that produced it and
		// can cost a later sample the comparison the old code took. Every
		// request therefore pays for its own fingerprints, and the only consumer
		// — the slope sample — keeps reading the same fields it always did.
		ledger.sentContext = {
			key,
			chars,
			frontier: Number.isInteger(frontier) ? frontier : source.length,
			revision: ledger.contextRevision,
			epoch: state.epoch ?? 0,
			headerKey: head?.key ?? null,
			messageHashes,
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
					prefixChars(messages, index < 0 ? messages.length : index);
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
		// The scan stays in index order and visits every entry. Stopping early at
		// the last measured assistant would read a different set of elements in a
		// different order, and `messages` can be any array the caller passes: with
		// an accessor on an element, the read pattern is observable. The value is
		// the same either way, so this keeps the caller's callbacks running in the
		// order they ran before.
		for (let index = 0; index < source.length; index += 1) {
			if (source[index]?.role === "assistant" && source[index]?.usage) {
				usageIndex = index;
			}
		}
		for (let index = usageIndex + 1; index < source.length; index += 1) {
			if (source[index]?.role === "custom") continue;
			pendingChars += messageChars(source[index]);
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
