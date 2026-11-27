// The directory baseline: the fork-tree snapshot a js beat prints, and the
// delta against the previous print.
//
// A delta is printed once per turn, but a retry must print the identical one,
// so `lastSeenDir` only advances when an assistant reply actually arrives. The
// staged value from the current turn waits in `pendingDirSeen`. The sequence
// counters let the reader answer "nothing moved" without re-projecting.
//
// Pure but for the state object it transitions: the projection functions are
// themselves pure.

import { diffDirectory, projectDirectory } from "../../scope/directory.mjs";

export function createDirectoryBaseline() {
	return {
		lastSeenDir: new Map(),
		pendingDirSeen: null,
		lastDirSeq: -1,
		lastPendingDirSeq: -1,
	};
}

/**
 * Advance the baseline once a reply landed.
 *
 * An aborted or failed reply carries no evidence that the tree shown to the
 * model was accepted, so it leaves the baseline where it was.
 */
export function settleBaseline(state, message) {
	if (message?.role !== "assistant") return false;
	if (message.stopReason === "aborted" || message.stopReason === "error") return false;
	if (!(state.pendingDirSeen instanceof Map)) return false;
	state.lastSeenDir = state.pendingDirSeen;
	state.pendingDirSeen = null;
	state.lastDirSeq = state.lastPendingDirSeq;
	return true;
}

/** Stage the snapshot this turn printed; it becomes the baseline on reply. */
export function stageScan(state, meta) {
	state.pendingDirSeen = meta?.currentDir ?? null;
	state.lastPendingDirSeq = Number.isInteger(meta?.dirSeq) ? meta.dirSeq : -1;
}

/** Forget every baseline, as a host boundary truncation must. */
export function resetBaseline(state) {
	state.lastSeenDir = new Map();
	state.pendingDirSeen = null;
	state.lastDirSeq = -1;
	state.lastPendingDirSeq = -1;
}

/**
 * The tree for this beat and its delta against the baseline.
 *
 * `scopesDelta` is null when the ledger's sequence has not moved and no staged
 * turn is pending, which lets the caller reuse the last print instead of
 * re-projecting a large tree.
 */
export function directoryDelta(state, ledger) {
	if (!ledger || typeof ledger !== "object") {
		const rootOnly = projectDirectory(null);
		return {
			scopesDelta: diffDirectory(state.lastSeenDir, rootOnly),
			currentDir: rootOnly,
			dirSeq: 0,
		};
	}
	const dirSeq = Number.isInteger(ledger.dirSeq) ? ledger.dirSeq : 0;
	if (
		state.lastDirSeq === dirSeq &&
		state.lastSeenDir.size > 0 &&
		state.pendingDirSeen === null
	) {
		return { scopesDelta: null, currentDir: state.lastSeenDir, dirSeq };
	}
	const currentDir = projectDirectory(ledger);
	return {
		scopesDelta: diffDirectory(state.lastSeenDir, currentDir),
		currentDir,
		dirSeq,
	};
}
