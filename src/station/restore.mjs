// Station restore: rebuild state from the newest persisted snapshot.

import {
	createState,
	deserializeState,
	foldStateChain,
	isStateCheckpoint,
} from "../scope/index.mjs";
import { toolCalls } from "../transcript/index.mjs";
import { record as recordDiagnostic } from "../host/diagnostics.mjs";

const SESSION_STATE_TYPE = "scope.state";
const MAX_REPLAY_ENTRIES = 512;

/** Walk the branch newest-first and collect the state chain, oldest-first. */
function collectChain(manager) {
	const branch = manager?.getBranch?.() ?? [];
	const chain = [];
	let anchored = false;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== SESSION_STATE_TYPE) {
			continue;
		}
		chain.push(entry.data);
		if (isStateCheckpoint(entry.data)) {
			anchored = true;
			break;
		}
		if (chain.length >= MAX_REPLAY_ENTRIES) break;
	}
	chain.reverse();
	return { chain, anchored };
}

/**
 * True when the branch holds a replayable base.
 *
 * A fresh session has none, so its first write must be a checkpoint rather
 * than a delta against a snapshot no entry carries.
 */
export function hasPersistedBase(manager) {
	try {
		const { chain, anchored } = collectChain(manager);
		return chain.length > 0 && anchored;
	} catch {
		return false;
	}
}

/**
 * The newest state entry on the live branch, when the host can say.
 *
 * `persist` holds the serialized state it last wrote, and a delta is only
 * meaningful while the entry carrying that state is still reachable. This id
 * is how the station re-checks the anchor after a fold or any other rewrite
 * of the branch.
 */
export function persistedBaseId(manager) {
	try {
		const branch = manager?.getBranch?.() ?? [];
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (entry?.type !== "custom" || entry.customType !== SESSION_STATE_TYPE) {
				continue;
			}
			return typeof entry.id === "string" ? entry.id : null;
		}
	} catch {
		// A host that cannot walk its branch leaves the anchor unverifiable.
	}
	return null;
}

function restoreState(manager) {
	try {
		const { chain, anchored } = collectChain(manager);
		if (chain.length > 0) {
			if (!anchored) {
				recordDiagnostic(
					"restore",
					new Error(
						`state chain has no checkpoint within ${MAX_REPLAY_ENTRIES} entries`,
					),
				);
				return createState();
			}
			const folded = foldStateChain(chain);
			if (folded === null) {
				recordDiagnostic("restore", new Error("state chain starts with a delta"));
				return createState();
			}
			{
				// A snapshot never carries a working-level stack or interval
				// collapses. Both are retired history: deserializeState drops
				// them, so there is nothing to prune here.
				return deserializeState(folded);
			}
		}
	} catch (error) {
		// Corrupt or absent history: start empty rather than guess.
		recordDiagnostic("restore", error);
	}
	return createState();
}

export { SESSION_STATE_TYPE, restoreState };
