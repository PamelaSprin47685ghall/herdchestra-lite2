/** Synchronous transcript operations for concurrent scope handoffs. */

import { foldStateChain, isStateCheckpoint } from "../scope/persistence.mjs";

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

const SCOPE_STATE_TYPE = "scope.state";

// Handoff journal markers. A completed copy writes begin ... end inside one
// atomic batch. A recovery writes abort to close a segment that will never
// finish. None of the three is a context message.
const HANDOFF_BEGIN = "fission.handoff.begin";
const HANDOFF_END = "fission.handoff.end";
const HANDOFF_ABORT = "fission.handoff.abort";

function scopeState(entry) {
	return entry.type === "custom" && entry.customType === SCOPE_STATE_TYPE;
}

// A copied segment carries structure for the recipient, never the source
// flow's own state ledger. `scope.state` entries hold scopes, charges, pins,
// seq/epoch, and JSON-patch deltas against the source flow's array indices.
// Replaying them into the recipient mixes two budgets and two scope stacks.
function copyable(entry) {
	return (entry.type === "message" && !broadcast(entry)) ||
		(entry.type === "custom" && !entry.customType?.startsWith("fission.") && !scopeState(entry)) ||
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

/** Canonical text used only to compare pins; stored pins keep their wording. */
export function normalizePin(pin) {
	if (typeof pin !== "string") return null;
	const text = pin.replace(/\r\n?/g, "\n").trim();
	return text === "" ? null : text;
}

/** Append unseen pins to `target`; never copies, rewrites, or deletes one. */
export function mergePins(target, incoming) {
	if (!Array.isArray(target) || !Array.isArray(incoming)) return target;
	const seen = new Set();
	for (const pin of target) {
		const key = normalizePin(pin);
		if (key !== null) seen.add(key);
	}
	for (const pin of incoming) {
		const key = normalizePin(pin);
		if (key === null || seen.has(key)) continue;
		seen.add(key);
		target.push(pin);
	}
	return target;
}

/**
 * Pins carried by the source segment, folded from its own state chain.
 *
 * Copied entries no longer include `scope.state`; the caller merges these into
 * the shared session pins. A segment whose state deltas have no checkpoint
 * anchor yields no pins: replaying them against the recipient's state is the
 * leak this module removes.
 */
export function handoffPins(entries) {
	const payloads = [];
	for (const entry of entries) if (scopeState(entry) && entry.data != null) payloads.push(entry.data);
	let start = -1;
	for (let index = payloads.length - 1; index >= 0; index -= 1) {
		if (isStateCheckpoint(payloads[index])) {
			start = index;
			break;
		}
	}
	if (start < 0) return [];
	const state = foldStateChain(payloads.slice(start));
	const out = [];
	mergePins(out, Array.isArray(state?.pins) ? state.pins : []);
	return out;
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
export async function copyHandoff(sm, { tail, entries, handoffId, sourceBeginId, shift = 0, levelRegex, vibeInactive, durableAtomicWrites, adoptPins }) {
	if (vibeInactive !== true) throw new Error("handoff requires confirmed inactive vibe runtime");
	if (durableAtomicWrites !== true || typeof sm.appendEntriesAtomically !== "function" || typeof sm.getSessionFile !== "function" || !sm.getSessionFile()) {
		throw new Error("handoff requires a persistent session with atomic writes");
	}
	const window = handoffWindow(entries);
	if (!Number.isSafeInteger(handoffId) || handoffId < 0) throw new Error("invalid handoff id");
	if (new Set(window.entries.map((entry) => entry.id)).size !== window.entries.length) throw new Error("duplicate handoff entry id");
	for (const entry of window.entries) mapId(entry.id, handoffId, new Set());
	// Read the source pins before the transaction. They travel outside the
	// journal segment: the source `scope.state` entries are never copied, and
	// the recipient's own state must stay its own.
	const pins = handoffPins(entries);
	const result = await sm.appendEntriesAtomically(() => {
		const used = new Set(sm.getEntries().map((entry) => entry.id));
		const ids = new Map();
		for (const entry of window.entries) {
			const id = mapId(entry.id, handoffId, used);
			used.add(id);
			ids.set(entry.id, id);
		}
		selectLeaf(sm, tail);
		let current = sm.appendCustomEntry(HANDOFF_BEGIN, { handoffId, sourceBeginId });
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
		current = sm.appendCustomEntry(HANDOFF_END, { handoffId, count: copied.length });
		if (leafId(sm) !== current) throw new Error("handoff leaf did not advance");
		return { tail: current, entries: copied, messages: handoffMessages(copied) };
	});
	result.pins = pins;
	if (typeof adoptPins === "function") adoptPins(pins);
	return result;
}

/** Identify incomplete handoffs; this does not discard or replay them. */
export function incompleteHandoffs(entries) {
	const pending = new Map();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === HANDOFF_BEGIN) pending.set(entry.data?.handoffId, entry);
		else if (entry.customType === HANDOFF_END || entry.customType === HANDOFF_ABORT) pending.delete(entry.data?.handoffId);
	}
	return [...pending.values()].map((entry) => ({ handoffId: entry.data?.handoffId, sourceBeginId: entry.data?.sourceBeginId, tail: entry.parentId, beginId: entry.id }));
}

function recoveryFailure(code, reason) {
	const error = new Error(reason);
	error.code = code;
	return error;
}

// The copy chains every entry onto the one before it, so an uncommitted
// segment is exactly the begin marker plus its structural descendants. The
// id marker alone is not used: natural ids share the same hexadecimal
// alphabet, and dropping a legitimate entry is worse than leaving residue.
function residueOf(entries, beginId) {
	const drop = new Set([beginId]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const entry of entries) {
			if (drop.has(entry.id)) continue;
			if (entry.parentId != null && drop.has(entry.parentId)) {
				drop.add(entry.id);
				grew = true;
			}
		}
	}
	return drop;
}

// A retried copy starts again at the same tail, so one handoff can leave
// several sibling begin markers. Pair each end with the newest open begin and
// keep every unpaired begin: `incompleteHandoffs` collapses by id, which would
// hide the older residue from the drop set.
function openHandoffs(entries) {
	const open = new Map();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const handoffId = entry.data?.handoffId;
		if (entry.customType === HANDOFF_BEGIN) {
			const list = open.get(handoffId) ?? [];
			list.push(entry);
			open.set(handoffId, list);
		} else if (entry.customType === HANDOFF_END) {
			const list = open.get(handoffId);
			if (list && list.length > 0) list.pop();
		} else if (entry.customType === HANDOFF_ABORT) {
			// An abort retires the whole transaction, including any sibling
			// begin left behind by an earlier retry.
			open.delete(handoffId);
		}
	}
	return [...open.entries()].filter(([, list]) => list.length > 0);
}

/**
 * Plan a durable recovery: which entries of an uncommitted handoff must be
 * discarded, and which handoffs can be copied again to the same tail.
 *
 * Pure. `recoverable` describes deletion: it refuses a plan whose deletion
 * would leave a kept entry pointing at a removed one. `retirable` describes
 * the deletion-free alternative. Retirement appends one abort marker at the
 * handoff's tail, so it needs a single shared tail per handoff, outside every
 * residue; otherwise the marker would itself land inside an abandoned
 * segment.
 */
export function planHandoffRecovery(entries) {
	const drop = new Set();
	const handoffs = openHandoffs(entries).map(([handoffId, begins]) => {
		const dropIds = new Set();
		for (const begin of begins) {
			for (const id of residueOf(entries, begin.id)) {
				drop.add(id);
				dropIds.add(id);
			}
		}
		const last = begins.at(-1);
		const tail = last.parentId ?? null;
		return {
			handoffId,
			sourceBeginId: last.data?.sourceBeginId,
			tail,
			beginId: last.id,
			beginIds: begins.map((begin) => begin.id),
			dropIds: [...dropIds],
			// The host removes an entry only when it has no content child, so a
			// lone begin marker is the one discard it can actually perform.
			discardable: dropIds.size === 1,
			oneTail: begins.every((begin) => (begin.parentId ?? null) === tail),
		};
	});
	const kept = entries.filter((entry) => !drop.has(entry.id));
	const keptIds = new Set(kept.map((entry) => entry.id));
	const dangling = [];
	for (const entry of kept) {
		if (entry.parentId != null && !keptIds.has(entry.parentId)) {
			dangling.push({ id: entry.id, field: "parentId", targetId: entry.parentId });
		}
		if (entry.type === "label" && entry.targetId != null && !keptIds.has(entry.targetId)) {
			dangling.push({ id: entry.id, field: "targetId", targetId: entry.targetId });
		}
		if (entry.type === "branch_summary" && entry.fromId != null && !keptIds.has(entry.fromId)) {
			dangling.push({ id: entry.id, field: "fromId", targetId: entry.fromId });
		}
		if (typeof entry.activeLeafId === "string" && drop.has(entry.activeLeafId)) {
			dangling.push({ id: entry.id, field: "activeLeafId", targetId: entry.activeLeafId });
		}
	}
	for (const handoff of handoffs) {
		handoff.retryable = handoff.tail === null || keptIds.has(handoff.tail);
		if (!handoff.retryable) handoff.reason = "the recipient tail is itself uncommitted residue";
		handoff.retirable = handoff.oneTail && (handoff.tail === null || !drop.has(handoff.tail));
		if (!handoff.retirable) {
			handoff.retireReason = handoff.oneTail
				? "the recipient tail is itself uncommitted residue"
				: "one handoff left begin markers at more than one tail";
		}
	}
	const blocked = handoffs.find((handoff) => !handoff.retirable);
	const retirable = blocked === undefined;
	const retireReason = blocked?.retireReason;
	if (dangling.length > 0) {
		return { recoverable: false, reason: "discarding the residue would leave dangling references", handoffs, dropIds: [...drop], kept, dangling, retirable, retireReason };
	}
	return { recoverable: true, handoffs, dropIds: [...drop], kept, retirable, retireReason };
}

/**
 * Durably close uncommitted handoff residue on the raw shared manager.
 *
 * Two host facts decide the mechanism
 * (oh-my-pi packages/coding-agent/src/session/session-manager.ts,
 * discardEntryDurably):
 *
 * 1. The host removes an entry only when every child is a `service_tier_change`
 *    metadata entry; a content child keeps the entry in the journal.
 * 2. Either way it appends a `branch_summary` marker as a child of the entry's
 *    parent. Once a leaf of a chained residue is removed, that marker makes the
 *    next ancestor unremovable, forever. The host therefore cannot delete a
 *    segment that holds any content, and no call order repairs that.
 *
 * The default path deletes only a lone begin marker and refuses any larger
 * residue before its first write. A larger segment needs `discardAll(ids)`, a
 * host primitive that does not exist yet. `retire: true` is the deletion-free
 * path: branch to the handoff's recorded tail, then append one
 * `fission.handoff.abort` marker. The abort closes the begin, the copied
 * entries stay in the journal as unreachable siblings, and the marker is the
 * last physical journal entry with the tail as parent, so the durable reload
 * leaf lands on the tail in one write.
 *
 * `discard(id)` remains an explicit per-entry override for a host whose
 * removal adds no marker. A crash leaves whatever the host already committed;
 * rerunning recomputes the residue and is safe.
 */
export async function recoverIncompleteHandoffs(sm, options = {}) {
	const { durableAtomicWrites, discard, discardAll, retire = false, entries = sm?.getEntries?.() } = options;
	if (!sm || typeof sm.getEntries !== "function") {
		throw recoveryFailure("FISSION_RECOVERY_UNSUPPORTED", "recovery needs a session manager that exposes getEntries()");
	}
	if (durableAtomicWrites !== true || typeof sm.getSessionFile !== "function" || !sm.getSessionFile()) {
		throw recoveryFailure("FISSION_RECOVERY_UNSUPPORTED", "recovery requires a persistent session with durable writes");
	}
	if (!Array.isArray(entries)) throw recoveryFailure("FISSION_RECOVERY_UNSUPPORTED", "recovery needs the session entries");
	const plan = planHandoffRecovery(entries);
	if (plan.handoffs.length === 0) return { recovered: [], dropped: [], retired: [], kept: plan.kept };
	if (retire === true && typeof discardAll !== "function") {
		if (!plan.retirable) throw recoveryFailure("FISSION_RECOVERY_UNSAFE", plan.retireReason ?? "the residue cannot be retired in place");
		return retireIncompleteHandoffs(sm, plan);
	}
	if (!plan.recoverable) throw recoveryFailure("FISSION_RECOVERY_UNSAFE", plan.reason);
	const expected = [...plan.dropIds];
	let dropped;
	if (typeof discardAll === "function") {
		try {
			await discardAll([...expected]);
		} catch (error) {
			throw new AggregateError([error], "bulk discard failed; rerunning recomputes the residue and is safe");
		}
		dropped = [...expected];
	} else {
		// A begin marker plus any descendant is a chain. The host cannot remove a
		// chain one entry at a time, so refuse before touching the journal.
		if (plan.handoffs.length > 1 || expected.length > 1) {
			throw recoveryFailure("FISSION_RECOVERY_UNSUPPORTED", "a chained handoff residue cannot be removed one entry at a time; supply discardAll(ids)");
		}
		let remove = typeof discard === "function" ? discard : null;
		if (remove === null && typeof sm.discardEntryDurably === "function") {
			remove = (id) => sm.discardEntryDurably(id);
		}
		if (remove === null) {
			throw recoveryFailure("FISSION_RECOVERY_UNSUPPORTED", "recovery needs discardEntryDurably(), discardAll(ids), or an explicit discard callback");
		}
		try {
			await remove(expected[0]);
		} catch (error) {
			throw new AggregateError([error], "recovery stopped before completing the discard; rerunning is safe");
		}
		dropped = [...expected];
	}
	const remaining = sm.getEntries();
	const remainingIds = new Set(remaining.map((entry) => entry.id));
	const leftovers = expected.filter((id) => remainingIds.has(id));
	if (leftovers.length > 0) {
		throw recoveryFailure("FISSION_RECOVERY_INCOMPLETE", `recovery left ${leftovers.length} uncommitted entries in the journal`);
	}
	const stillPending = new Set(incompleteHandoffs(remaining).map((item) => item.handoffId));
	for (const handoff of plan.handoffs) {
		if (stillPending.has(handoff.handoffId)) {
			throw recoveryFailure("FISSION_RECOVERY_INCOMPLETE", `handoff ${handoff.handoffId} still has an open begin marker`);
		}
	}
	return {
		recovered: plan.handoffs.map(({ handoffId, sourceBeginId, tail, retryable }) => ({ handoffId, sourceBeginId, tail, retryable })),
		dropped,
		retired: [],
		kept: plan.kept,
	};
}

/**
 * Close every residue in place without removing a single entry.
 *
 * A lone begin marker is still handed to the host's discard, which removes it
 * cleanly. A larger residue is retired with an abort marker at its tail: the
 * copied entries stay in the journal, but the active branch no longer contains
 * them, so no context carries half a handoff. Every write is an append, so a
 * crash between handoffs leaves the journal consistent and rerunning is safe.
 */
async function retireIncompleteHandoffs(sm, plan) {
	const dropped = [];
	const retired = [];
	const remove = typeof sm.discardEntryDurably === "function" ? (id) => sm.discardEntryDurably(id) : null;
	for (const handoff of plan.handoffs) {
		if (handoff.discardable && remove !== null) {
			await remove(handoff.beginId);
			dropped.push(handoff.beginId);
			continue;
		}
		if (typeof sm.appendCustomEntry !== "function" || (handoff.tail !== null && typeof sm.branch !== "function")) {
			throw recoveryFailure("FISSION_RECOVERY_UNSUPPORTED", "retirement needs branch(id) and appendCustomEntry(type, data)");
		}
		if (handoff.tail === null) {
			if (typeof sm.resetLeaf !== "function") {
				throw recoveryFailure("FISSION_RECOVERY_UNSUPPORTED", "retirement needs resetLeaf() for a root residue");
			}
			sm.resetLeaf();
		} else {
			sm.branch(handoff.tail);
		}
		const abortId = sm.appendCustomEntry(HANDOFF_ABORT, {
			handoffId: handoff.handoffId,
			beginIds: handoff.beginIds,
			retired: handoff.dropIds.length,
		});
		if (typeof abortId !== "string" || abortId === "") {
			throw recoveryFailure("FISSION_RECOVERY_INCOMPLETE", `handoff ${handoff.handoffId}: the host did not return an abort entry id`);
		}
		retired.push({ handoffId: handoff.handoffId, abortId, tail: handoff.tail, entries: handoff.dropIds.length });
	}
	const remaining = sm.getEntries();
	const remainingIds = new Set(remaining.map((entry) => entry.id));
	const leftovers = dropped.filter((id) => remainingIds.has(id));
	if (leftovers.length > 0) {
		throw recoveryFailure("FISSION_RECOVERY_INCOMPLETE", `recovery left ${leftovers.length} uncommitted entries in the journal`);
	}
	const stillPending = new Set(incompleteHandoffs(remaining).map((item) => item.handoffId));
	for (const handoff of plan.handoffs) {
		if (stillPending.has(handoff.handoffId)) {
			throw recoveryFailure("FISSION_RECOVERY_INCOMPLETE", `handoff ${handoff.handoffId} still has an open begin marker`);
		}
	}
	// The abandoned entries may stay in the journal, but never in the branch
	// the next prompt rebuilds its context from.
	if (typeof sm.getBranch === "function") {
		const branchIds = new Set(sm.getBranch().map((entry) => entry.id));
		for (const handoff of plan.handoffs) {
			const onBranch = handoff.dropIds.filter((id) => branchIds.has(id));
			if (onBranch.length > 0) {
				throw recoveryFailure("FISSION_RECOVERY_INCOMPLETE", `handoff ${handoff.handoffId} residue is still on the active branch`);
			}
		}
	}
	return {
		recovered: plan.handoffs.map(({ handoffId, sourceBeginId, tail, retryable }) => ({ handoffId, sourceBeginId, tail, retryable })),
		dropped,
		retired,
		kept: remaining,
	};
}
