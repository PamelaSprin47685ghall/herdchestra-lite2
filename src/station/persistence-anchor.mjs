/**
 * Persistence anchor: the append-only state chain's baseline and the rebase
 * that follows a branch rewrite.
 *
 * Three fields move together here — the last serialized state, the entry that
 * carries it, and the count since the last checkpoint — because a delta is
 * only valid while its anchor is still on the branch. Pure synchronous state;
 * the manager and the serialization helpers arrive by injection.
 */

export function createPersistenceAnchor({
	manager,
	state,
	initialState,
	initialEntryId,
	serialize,
	plan,
	type,
	noteError,
}) {
	let lastPersisted = initialState;
	let lastStateEntryId = initialEntryId;
	let writes = 0;
	let rebased = false;

	/** True when the entry carrying the baseline is still on the leaf path. */
	function anchorOnBranch() {
		if (lastStateEntryId === null) return false;
		if (typeof manager?.getBranch !== "function") return false;
		try {
			const branch = manager.getBranch();
			if (!Array.isArray(branch)) return false;
			for (let index = branch.length - 1; index >= 0; index -= 1) {
				if (branch[index]?.id === lastStateEntryId) return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Write the pending state slice. Returns false only when the write was owed
	 * and did not happen, so a caller can report a lost state write instead of
	 * assuming success; "nothing to write" is a success.
	 */
	function persist() {
		if (!manager || typeof manager.appendCustomEntry !== "function") return false;
		try {
			// Anything that rewrites the branch (a fold, an export, a future
			// history tool) drops the entry that anchors `lastPersisted`. A
			// delta written next would replay onto a truncated chain or onto
			// none at all, so the anchor is re-checked here rather than
			// trusted from whichever caller rewrote the branch.
			if (lastPersisted !== null && !anchorOnBranch()) {
				lastPersisted = null;
				writes = 0;
				lastStateEntryId = null;
			}
			const next = serialize(state());
			const entry = plan(lastPersisted, next, writes);
			if (!entry) return true;
			const entryId = manager.appendCustomEntry(type, entry);
			lastStateEntryId = typeof entryId === "string" ? entryId : null;
			lastPersisted = next;
			writes = entry.kind === "checkpoint" ? 0 : writes + 1;
			return true;
		} catch (error) {
			noteError("persist", error);
			return false;
		}
	}

	/**
	 * A fold rewrote the branch, so every state entry after the fold point is
	 * gone. Drop the baseline and write a checkpoint while the rebased branch
	 * is the live one. The pending rebase tells `maybeRebase` to hand the new
	 * branch to the agent context.
	 */
	function rebase() {
		lastPersisted = null;
		writes = 0;
		lastStateEntryId = null;
		rebased = true;
		persist();
	}

	return {
		persist,
		rebase,
		needsRebase() {
			return rebased;
		},
		clearRebase() {
			rebased = false;
		},
	};
}
