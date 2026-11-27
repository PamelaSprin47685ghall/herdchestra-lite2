// Handoff session: branch compaction boundary helpers. No station state lives here.

/**
 * Count handoff compactions on the live branch. The host writes
 * `{ type: "compaction", method: "handoff" }`; older builds carry the method in
 * `details`. A null result means the manager cannot answer, so callers must not
 * treat "no count" as "no handoff".
 */
export function countHandoffCompactions(manager) {
	if (!manager || typeof manager.getBranch !== "function") return null;
	try {
		const branch = manager.getBranch();
		if (!Array.isArray(branch)) return null;
		let count = 0;
		for (const entry of branch) {
			if (!entry || entry.type !== "compaction") continue;
			const method = entry.method ?? entry.details?.method;
			if (method === "handoff") count += 1;
		}
		return count;
	} catch {
		return null;
	}
}

/**
 * Append the handoff compaction at the current leaf.
 *
 * `firstKeptEntryId` names the first entry the host must retain before the
 * compaction boundary; an empty string retains nothing. Root rewind passes the
 * first restored user entry so the user's own words survive the cut, in order,
 * ahead of the record.
 */
export function appendHandoffCompaction(manager, summary, tokensBefore = 0, firstKeptEntryId = "") {
	if (!manager || typeof manager.appendCompaction !== "function") return false;
	const tokens = Number.isFinite(tokensBefore) ? tokensBefore : 0;
	const firstKept = typeof firstKeptEntryId === "string" ? firstKeptEntryId : "";
	try {
		if (manager.appendCompaction.length >= 3) {
			manager.appendCompaction(summary, undefined, firstKept, tokens, {
				method: "handoff",
				fromExtension: true,
			});
		} else {
			manager.appendCompaction("handoff", { summary, focus: summary });
		}
		return true;
	} catch {
		return false;
	}
}
