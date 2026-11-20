/** Synchronous transcript operations for concurrent scope handoffs. */

function selectLeaf(sm, id) {
	if (id == null) sm.resetLeaf();
	else sm.branch(id);
}

// getConversationTip() can skip metadata. The branch ends at the real leaf.
function leafId(sm) {
	const branch = sm.getBranch();
	return branch.at(-1)?.id ?? null;
}

export function appendAt(sm, tail, write) {
	const saved = leafId(sm);
	let value;
	let failure;
	let failed = false;
	try {
		selectLeaf(sm, tail);
		value = write();
		if (value && typeof value.then === "function") {
			throw new TypeError("appendAt requires a synchronous write");
		}
	} catch (error) {
		failed = true;
		failure = error;
	}
	try {
		selectLeaf(sm, saved);
		if (leafId(sm) !== saved) throw new Error("leaf not restored");
	} catch (error) {
		throw new AggregateError(failed ? [failure, error] : [error], "leaf restore failed");
	}
	if (failed) throw failure;
	return value;
}

/** Allocate deterministic hexadecimal IDs without colliding with existing entries. */
export function mapId(oldId, handoffId, used) {
	if (!Number.isSafeInteger(handoffId) || handoffId < 0) throw new Error("invalid handoff id");
	const base = `${oldId}f${handoffId.toString(16)}`;
	if (!/^[0-9a-f]+$/.test(base)) throw new Error("invalid handoff id");
	let id = base;
	for (let salt = 1; used.has(id); salt += 1) id = `${base}f${salt.toString(16)}`;
	return id;
}

function broadcast(entry) {
	return Boolean(entry.message?.details?.fissionBroadcast?.broadcastId);
}

function copyable(entry) {
	return (entry.type === "message" && !broadcast(entry)) ||
		(entry.type === "custom" && !entry.customType?.startsWith("fission.")) ||
		["model_usage", "label", "thinking_level_change", "mode_change", "branch_summary"].includes(entry.type);
}

/** Select the post-compaction window and retain its summary as a message. */
export function handoffWindow(entries) {
	let start = 0;
	let summary;
	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		const index = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		if (index < 0) throw new Error("compaction keep entry is outside the handoff");
		start = index;
		summary = entry.summary;
	}
	return { entries: entries.slice(start).filter(copyable), summary };
}

function shiftMessage(message, shift, levelPattern) {
	if (!shift || !levelPattern) return structuredClone(message);
	const copy = structuredClone(message);
	const replace = (text) => text.replace(levelPattern, (_, prefix, number) => `${prefix}${Number(number) + shift}`);
	if (typeof copy.content === "string") copy.content = replace(copy.content);
	else if (Array.isArray(copy.content)) {
		for (const block of copy.content) {
			if (typeof block.text === "string") block.text = replace(block.text);
		}
	}
	return copy;
}

/** Derive the level anchor from a receipt template containing {{level}}. */
export function levelPattern(template) {
	const match = template.match(/(\S+\s+\S+\s+)\{\{level\}\}/);
	if (!match) throw new Error("receipt template has no level anchor");
	const prefix = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(${prefix})(\\d+)`, "g");
}

/** Convert entries that belong in model context, preserving their order. */
export function handoffMessages(entries) {
	const result = [];
	for (const entry of entries) {
		if (entry.type === "message") result.push(entry.message);
		else if (entry.type === "custom" && /^scope\.(begin|end)$/.test(entry.customType)) {
			result.push({ role: "custom", customType: entry.customType, content: JSON.stringify(entry.data ?? {}), display: false, timestamp: Date.now() });
		}
	}
	return result;
}

/** The caller must verify durable rollback and exclude vibe for the entire transaction. */
export async function copyHandoff(sm, { tail, entries, handoffId, sourceBeginId, shift = 0, levelRegex, vibeInactive, durableAtomicWrites }) {
	if (vibeInactive !== true) throw new Error("handoff requires confirmed inactive vibe runtime");
	if (durableAtomicWrites !== true || typeof sm.appendEntriesAtomically !== "function" || typeof sm.getSessionFile !== "function" || !sm.getSessionFile()) {
		throw new Error("handoff requires a persistent session with atomic writes");
	}
	const window = handoffWindow(entries);
	if (!Number.isSafeInteger(handoffId) || handoffId < 0) throw new Error("invalid handoff id");
	if (new Set(window.entries.map((entry) => entry.id)).size !== window.entries.length) throw new Error("duplicate handoff entry id");
	for (const entry of window.entries) mapId(entry.id, handoffId, new Set());
	return sm.appendEntriesAtomically(() => {
	const used = new Set(sm.getEntries().map((entry) => entry.id));
	const ids = new Map();
	for (const entry of window.entries) {
		const id = mapId(entry.id, handoffId, used);
		used.add(id);
		ids.set(entry.id, id);
	}
	selectLeaf(sm, tail);
	let current = sm.appendCustomEntry("fission.handoff.begin", { handoffId, sourceBeginId });
	const copied = [];
	if (window.summary !== undefined) {
		const message = { role: "custom", customType: "fission.compaction-summary", content: window.summary, display: false, details: { fissionCarry: "compaction-summary" }, timestamp: Date.now() };
		current = sm.appendMessage(message);
		copied.push({ type: "message", message });
	}
	for (const entry of window.entries) {
		const copy = { ...entry, id: ids.get(entry.id), parentId: current };
		delete copy.activeLeafId;
		if (entry.type === "message") copy.message = shiftMessage(entry.message, shift, levelRegex);
		if (entry.type === "label") copy.targetId = ids.get(entry.targetId) ?? entry.targetId;
		if (entry.type === "branch_summary") copy.fromId = ids.get(entry.fromId) ?? entry.fromId;
		if (entry.type === "custom" && entry.data?.beginToolCallId) {
			copy.data = { ...entry.data, beginToolCallId: ids.get(entry.data.beginToolCallId) ?? entry.data.beginToolCallId };
		}
		sm.ingestReplicatedEntry(copy);
		current = copy.id;
		copied.push(copy);
	}
	current = sm.appendCustomEntry("fission.handoff.end", { handoffId, count: copied.length });
	if (leafId(sm) !== current) throw new Error("handoff leaf did not advance");
	return { tail: current, entries: copied, messages: handoffMessages(copied) };
	});
}

/** Identify incomplete handoffs; this does not discard or replay them. */
export function incompleteHandoffs(entries) {
	const pending = new Map();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === "fission.handoff.begin") pending.set(entry.data?.handoffId, entry);
		else if (entry.customType === "fission.handoff.end") pending.delete(entry.data?.handoffId);
	}
	return [...pending.values()].map((entry) => ({ handoffId: entry.data?.handoffId, sourceBeginId: entry.data?.sourceBeginId, tail: entry.parentId, beginId: entry.id }));
}
