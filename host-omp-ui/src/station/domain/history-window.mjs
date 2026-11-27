// The windowed tail of one branch: the messages a frame can read, the ordinal
// they start at, and the index that says where they sit.
//
// The host owns the branch array and may append to that very array, so nothing
// here copies it. The window is a bounded projection of its tail, and any older
// page is rebuilt from the same entries, which is why a page and a frame can
// never disagree about what the conversation held.
//
// A live message the host has not written yet exists only in the window. Every
// rule below protects it: the trim may not drop past the branch's end, and a
// rebase rebuilds only the branch part.

import {
	buildHistoryIndex,
	extendHistoryIndex,
	reconstructRange,
} from "./transcript-model.mjs";

/** A frame plus the turn-alignment back-scan. Anything older is not held. */
export const HISTORY_WINDOW = 512;

/**
 * A history window over `store.history` and `store.messages`.
 *
 * `store` is the Station's state bag; this module is the only place that
 * maintains those two fields, so the rebase rule, the stitch rule and the trim
 * floor live in one file instead of being spread across the session entries.
 */
export function createHistoryWindow(store, options = {}) {
	const windowSize =
		Number.isInteger(options.window) && options.window > 0 ? options.window : HISTORY_WINDOW;

	/**
	 * The branch index, rebuilt when the host grew or replaced the branch.
	 *
	 * An index built before an append still claims the old length, and every
	 * ordinal past it answers as absent, so a page for a message the branch
	 * already holds would be reported stale. Identity, length and the tail
	 * reference are the cheap signals; a mismatch rebuilds once.
	 */
	function currentIndex() {
		const entries = store.history.entries;
		if (!entries) return null;
		const index = store.history.index;
		// Equal length alone does not mean the same branch: a rewound and
		// re-appended branch has the same size and different contents. The tail
		// reference catches a rewrite that replaces the end; it is the cheapest
		// signal, not a proof that earlier entries are untouched.
		if (
			index &&
			index.source === entries &&
			index.entryCount === entries.length &&
			index.tailRef === (entries.length > 0 ? entries[entries.length - 1] : null)
		) {
			return index;
		}
		// An append is the common case: the host adds to its own array between two
		// frames, so the index only has to learn the tail. A replaced or shorter
		// array is not growth, and `extendHistoryIndex` answers it with a full
		// build — the same call hydration makes.
		const grew =
			Boolean(index) && index.source === entries && entries.length > index.entryCount;
		const rebuilt = extendHistoryIndex(index, entries);
		store.history.index = rebuilt;
		if (!grew) {
			// The branch was rewound, replaced or rewritten in place, so the held
			// window was built from entries that no longer exist. Only the branch
			// part is rebuilt: everything at an ordinal the branch does not cover
			// exists nowhere else. This runs from the trim, after a live append, so
			// discarding the live tail here would delete the message just streamed.
			const branch = rebuilt.entryOfMessage.length;
			const start = Math.max(0, branch - windowSize);
			const fromBranch = reconstructRange(entries, start, branch, rebuilt);
			const liveTail = store.messages.slice(
				Math.max(0, branch - store.history.base),
			);
			store.history.base = start;
			store.messages = [...fromBranch, ...liveTail];
		}
		return rebuilt;
	}

	/**
	 * How many messages the conversation has.
	 *
	 * The branch holds what it holds, and the window may already hold messages the
	 * branch does not: an event appends a message before the host writes its
	 * entry. The transcript is as long as the later of the two, so a frame at the
	 * tail sees the live message rather than the branch's older count.
	 */
	function total() {
		const index = currentIndex();
		const branch = index ? index.entryOfMessage.length : 0;
		return Math.max(branch, store.history.base + store.messages.length);
	}

	/**
	 * The messages for ordinals `[from, to)`.
	 *
	 * Inside the held window this is a slice. Outside it, the range is rebuilt
	 * from the branch, so an old page costs a tour of that page, not of the
	 * session. A strip that crosses the window's head is stitched: the branch
	 * answers what it has, and the window answers the live tail the branch has
	 * not caught up with.
	 */
	function range(from, to) {
		const entries = store.history.entries;
		const index = currentIndex();
		if (!entries || !index) return store.messages.slice(from, to);
		const size = total();
		const start = Math.max(0, Math.min(from, size));
		const end = Math.max(start, Math.min(to, size));
		const base = store.history.base;
		if (start >= base && end <= base + store.messages.length) {
			return store.messages.slice(start - base, end - base);
		}
		const branch = index.entryOfMessage.length;
		if (end <= branch) {
			const rebuilt = reconstructRange(entries, start, end, index);
			if (end === size && end - start <= windowSize) {
				store.messages = rebuilt;
				store.history.base = start;
			}
			return rebuilt;
		}
		// The strip crosses what the branch covers and what only the held window
		// has, and they must meet exactly once: the branch answers up to the
		// window's first ordinal, the window answers from there. Cutting the branch
		// at its own length repeats the ordinals the window also holds above it;
		// skipping to the window's head loses the ones between.
		const boundary = Math.min(end, Math.max(start, base));
		const head = start < boundary ? reconstructRange(entries, start, boundary, index) : [];
		const tail = store.messages.slice(
			Math.max(0, boundary - base),
			Math.max(0, end - base),
		);
		return [...head, ...tail];
	}

	/**
	 * Adopt a branch, keeping only its tail.
	 *
	 * The host already holds every entry; what a long session cannot afford is a
	 * second full projection of them. Only the window a frame can read is built
	 * here, and the rest is rebuilt on demand from the same entries.
	 */
	function reset(list) {
		const entries = list ?? [];
		const index = buildHistoryIndex(entries);
		const size = index.entryOfMessage.length;
		const start = Math.max(0, size - windowSize);
		store.history = { entries, index, base: start };
		store.messages = reconstructRange(entries, start, size, index);
	}

	/** Drop the oldest held messages once the window grows past its bound. */
	function trim() {
		// Only what the branch can answer again may be dropped. A live message the
		// host has not written yet exists nowhere else, so trimming it away would
		// lose it from every later frame. The floor is capped by the branch length
		// read now, not at hydration: the window stays bounded by the branch
		// instead of growing with the conversation.
		const current = currentIndex();
		const branch = current ? current.entryOfMessage.length : 0;
		const ideal = store.history.base + store.messages.length - windowSize;
		const floor = Math.max(store.history.base, Math.min(ideal, branch));
		const drop = floor - store.history.base;
		if (drop <= 0) return;
		store.messages = store.messages.slice(drop);
		store.history.base = floor;
	}

	return {
		currentIndex,
		total,
		range,
		reset,
		trim,
		base: () => store.history.base,
		messages: () => store.messages,
		index: () => store.history.index,
	};
}
