// The capability projection: one gatherer, one projection, one render.
//
// The probe, the cache signature and the vm binding all read the same frozen
// projection, and the receipt is rendered from it once. Keeping the projection
// and the render in one module is what makes `projectCapabilities` and
// `renderConsoleReceipt` single call sites: a second one would be a second
// definition of what the model was shown, and the provider's prompt cache would
// see a prefix that changed for no reason.
//
// Pure but for the small bookkeeping object it transitions.

import { projectCapabilities, renderConsoleReceipt } from "./capabilities.mjs";

export function createProjectionState() {
	return {
		// The tool names the previous receipt printed, so the one turn where keys
		// disappear can print the removed names first.
		lastCapKeys: [],
		// The directory snapshot this projection printed; the next receipt stages
		// it as the baseline candidate.
		lastDirMeta: null,
	};
}

/** The frozen projection for this beat. */
export function project(snapshot) {
	return projectCapabilities(snapshot);
}

/** Record the directory snapshot the projection printed. */
export function stageDirMeta(state, snapshot) {
	state.lastDirMeta = {
		currentDir: snapshot?._currentDir ?? null,
		dirSeq: snapshot?._dirSeq ?? -1,
	};
	return state.lastDirMeta;
}

/** The tool names that vanished since the previous receipt. */
export function removedKeys(previous, tools) {
	const now = Array.isArray(tools) ? tools : [];
	return (Array.isArray(previous) ? previous : []).filter((key) => !now.includes(key));
}

/**
 * Advance the printed tool set and return the names it dropped.
 *
 * The level-triggered probe prints the whole current projection every turn, so
 * the only edge is a name that is gone; that is the one line printed above the
 * projection.
 */
export function advanceCapKeys(state, tools) {
	const removed = removedKeys(state.lastCapKeys, tools);
	state.lastCapKeys = Array.isArray(tools) ? tools.slice() : [];
	return removed;
}

/** Render the console receipt for this projection, dropping any lost keys. */
export function renderReceipt(state, projection, { chinese = "on" } = {}) {
	const removed = advanceCapKeys(state, projection.tools);
	return renderConsoleReceipt(projection, { removedKeys: removed, chinese });
}
