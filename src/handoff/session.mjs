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

export function appendHandoffCompaction(manager, summary, tokensBefore = 0) {
	if (!manager || typeof manager.appendCompaction !== "function") return false;
	const tokens = Number.isFinite(tokensBefore) ? tokensBefore : 0;
	try {
		if (manager.appendCompaction.length >= 3) {
			manager.appendCompaction(summary, undefined, "", tokens, {
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
