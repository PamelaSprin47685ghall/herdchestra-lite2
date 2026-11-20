// Journal-derived structure: read-only queries over the host's session tree.
//
// The host appends through the shared SessionManager directly, so a cached
// tail goes stale after the first turn. Every function here derives its answer
// from the live journal instead of remembering it, and takes the manager as an
// explicit argument so a caller cannot reach a different journal by accident.
//
// Nothing in this module holds state, throws a scheduler error, or emits an
// event. A caller that needs a refusal wraps the answer it gets.

const TOOL_RESULT_ROLES = new Set(["toolResult", "tool_result", "tool"]);

/** A guard against a parent chain that loops on a corrupt journal. */
const MAX_DEPTH = 100000;

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

/** True when `entry`'s parent chain reaches `ancestorId`. */
export function isDescendant(entry, ancestorId, byId) {
	let current = entry;
	for (let guard = 0; current && guard < MAX_DEPTH; guard += 1) {
		if (current.id === ancestorId) return true;
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return false;
}

/**
 * The newest journal entry that belongs to `flow`'s branch, or its begin entry
 * when nothing has been appended under it yet.
 */
export function tailOf(manager, flow) {
	if (!flow.beginId) return null;
	const entries = manager.getEntries();
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (isDescendant(entries[index], flow.beginId, byId)) return entries[index].id;
	}
	return flow.beginId;
}

/** Scope depth at one entry, counted from `scope.begin`/`scope.end` pairs. */
export function depthAt(manager, entryId) {
	let depth = 0;
	for (const entry of manager.getBranch(entryId)) {
		if (entry.type !== "custom") continue;
		if (entry.customType === "scope.begin") depth += 1;
		else if (entry.customType === "scope.end") depth -= 1;
	}
	return depth;
}

/** The highest handoff id already recorded in the journal. */
export function maxHandoffId(entries) {
	let max = 0;
	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== "fission.handoff.begin") continue;
		const value = entry.data?.handoffId;
		if (Number.isSafeInteger(value) && value > max) max = value;
	}
	return max;
}

/**
 * The persisted toolResult entry for one call, or null.
 *
 * A per-flow receipt shares the batch's toolCallId, so it is skipped: the
 * owner's ack is the result the control path persisted, never a flow receipt.
 */
export function findToolResultId(manager, toolCallId) {
	if (!isNonEmptyString(toolCallId)) return null;
	const entries = manager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		const message = entry?.type === "message" ? entry.message : undefined;
		if (!message || !TOOL_RESULT_ROLES.has(message.role)) continue;
		if (message.details?.fissionReceipt) continue;
		if (message.toolCallId === toolCallId || message.toolCallID === toolCallId) return entry.id;
	}
	return null;
}
