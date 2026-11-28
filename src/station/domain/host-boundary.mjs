// The host-boundary cache: one keyed scan and one projection per branch leaf.
//
// Two different caches share one cause. `hostBoundaryKey` walks a transcript
// backwards to the last handoff marker, so calling it for every event of a turn
// costs Θ(entries) each time; the projection of the message list is likewise
// rebuilt per leaf. The projected array is the same object for every event of a
// turn, and the only thing an append changes is its length, so identity plus
// length proves both caches are still current.
//
// Pure but for the cache object it transitions: no station, no host, no clock.

import { hostBoundaryKey } from "../messages.mjs";

  /**
   * The boundary cache for one station.
   *
   * `initialKey` is the boundary the previous process already absorbed: the key
   * is a pure function of the transcript, so a reload that finds the same key
   * must not replay it as a fresh handoff.
   *
   * `adoptFirst` marks a snapshot written before the key was persisted. Its
   * transcript may already carry a handoff that the old code absorbed without
   * recording it. The first observation adopts whatever boundary the transcript
   * holds instead of reporting a move; otherwise the reload would truncate a
   * state the host never dropped.
   */
  export function createHostBoundary(initialKey = null, { adoptFirst = false } = {}) {
  	return {
  		// The boundary key of the last observed transcript.
  		key: typeof initialKey === "string" && initialKey.length > 0 ? initialKey : null,
  		// A pre-persistence snapshot: take the first observed key, do not move.
  		adoptFirst: adoptFirst === true,
  		// { messages, length, key } for the array the key was computed from.
  		scan: null,
  		// { leafId, messages } for the branch the projection was built from.
  		contextCache: null,
  	};
  }

/** The boundary key for this exact array, or the cached one. */
export function boundaryKeyOf(boundary, messages) {
	const scan = boundary.scan;
	if (scan && scan.messages === messages && scan.length === messages.length) {
		return scan.key;
	}
	const key = hostBoundaryKey(messages);
	boundary.scan = { messages, length: messages.length, key };
	return key;
}

/**
 * Observe a transcript and report whether the boundary moved.
 *
 * A moved boundary means the host dropped inner scopes: the caller truncates
 * the state, resets the directory baseline and the usage watermark, and
 * persists. This function only decides; it changes no state beyond the cache.
 */
  export function observeHostBoundary(boundary, messages) {
  	const key = boundaryKeyOf(boundary, messages);
  	if (boundary.adoptFirst === true) {
  		boundary.adoptFirst = false;
  		if (key && boundary.key === null) {
  			boundary.key = key;
  			return { changed: false, key, adopted: true };
  		}
  		if (!key) return { changed: false, key: null, adopted: false };
  	}
  	if (!key || key === boundary.key) return { changed: false, key, adopted: false };
  	boundary.key = key;
  	return { changed: true, key, adopted: false };
  }

  /**
   * Take the transcript as the known boundary without asking whether it moved.
   *
   * A compact replaces the transcript, so the handoff marker the last scan saw
   * may be gone. Writing the key back keeps the persisted value equal to the
   * transcript, which is what lets a later handoff report a real move.
   */
  export function syncHostBoundary(boundary, messages) {
  	const key = boundaryKeyOf(boundary, messages);
  	boundary.adoptFirst = false;
  	boundary.key = key ?? null;
  	return boundary.key;
  }

/** Drop the scan only; the last committed key still answers the next event. */
export function clearScan(boundary) {
	boundary.scan = null;
}

/** Drop the leaf projection, forcing the next `contextMessages` to rebuild. */
export function clearContextCache(boundary) {
	boundary.contextCache = null;
}

/**
 * Read the cached projection for this leaf, or build it with `build` and cache
 * it. A null leaf id disables the cache, which is the old behavior rather than
 * a guess.
 */
export function contextForLeaf(boundary, leafId, build) {
	const usable = leafId !== null && leafId !== undefined;
	const cache = boundary.contextCache;
	if (usable && cache && cache.leafId === leafId) return cache.messages;
	const messages = build();
	boundary.contextCache = usable ? { leafId, messages } : null;
	return messages;
}

/** Forget every cache, as an external session transition must. */
export function resetHostBoundary(boundary) {
	boundary.key = null;
	boundary.scan = null;
	boundary.contextCache = null;
}
