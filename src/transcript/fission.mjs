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

/**
 * Walk the journal from `to` back to `from`; null when they are not connected.
 *
 * The copy records a source range, not a list of entries. Recovery rebuilds the
 * segment from the journal with this walk, so the recorded range must still
 * exist and still describe the window the original copy would have used.
 */
export function handoffSegment(entries, from, to) {
	if (typeof from !== "string" || from === "" || typeof to !== "string" || to === "") return null;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const segment = [];
	let current = byId.get(to);
	for (let guard = 0; current !== undefined && guard <= entries.length; guard += 1) {
		segment.push(current);
		if (current.id === from) return segment.reverse();
		current = current.parentId != null ? byId.get(current.parentId) : undefined;
	}
	return null;
}

// One broadcast can reach the journal in two shapes: a plain message whose
// AgentMessage carries `details`, and a custom message whose `customType` and
// `details` sit on the entry itself. Both are the same user instruction,
// already delivered to every running flow, so neither may be copied.
function broadcast(entry) {
	if (entry.customType === "fission.broadcast") return true;
	const details = entry.message?.details ?? entry.details;
	return Boolean(details?.fissionBroadcast?.broadcastId);
}

const SCOPE_STATE_TYPE = "scope.state";
// A host-level state snapshot. The session manager keeps it out of the
// conversation tip, and no recipient may receive it as context.
const EVAL_STATE_CONTEXT_TYPE = "eval-state-context";
const FISSION_CUSTOM_PREFIX = "fission.";

// Handoff journal markers. A completed copy writes begin ... end inside one
// atomic batch. A recovery writes abort to close a segment that will never
// finish. None of the three is a context message.
const HANDOFF_BEGIN = "fission.handoff.begin";
const HANDOFF_END = "fission.handoff.end";
const HANDOFF_ABORT = "fission.handoff.abort";

function scopeState(entry) {
	return entry.type === "custom" && entry.customType === SCOPE_STATE_TYPE;
}

// Custom messages carry model context, unlike the journal's `custom` ledger
// entries. Ledger types (`fission.*`) and state snapshots never travel.
function contextCustomMessage(entry) {
	const customType = entry.customType;
	return typeof customType === "string" &&
		customType !== "" &&
		!customType.startsWith(FISSION_CUSTOM_PREFIX) &&
		customType !== EVAL_STATE_CONTEXT_TYPE;
}

// A copied segment carries structure for the recipient, never the source
// flow's own state ledger. `scope.state` entries hold scopes, charges, pins,
// seq/epoch, and JSON-patch deltas against the source flow's array indices.
// Replaying them into the recipient mixes two budgets and two scope stacks.
function copyable(entry) {
	if (entry.type === "message") return !broadcast(entry);
	if (entry.type === "custom_message") return !broadcast(entry) && contextCustomMessage(entry);
	return (entry.type === "custom" && !entry.customType?.startsWith(FISSION_CUSTOM_PREFIX) && !scopeState(entry)) ||
		["model_usage", "label", "thinking_level_change", "mode_change", "branch_summary"].includes(entry.type);
}

/** Select the post-compaction window and retain its summary as a message. */
export function handoffWindow(entries) {
	let start = 0;
	let summary;
	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		const index = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		// A compaction can keep a window that starts before this segment: the
		// flow's own `scope.begin` is not the first entry on its branch. The
		// segment cannot be widened, so the retained window is the whole segment
		// and the summary still goes in front. Failing here would strand every
		// flow that compacted across its own begin.
		start = index < 0 ? 0 : index;
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

function shiftText(text, shift, levelPattern) {
	if (typeof text !== "string" || !shift || !levelPattern) return text;
	return text.replace(levelPattern, (_, prefix, number) => `${prefix}${Number(number) + shift}`);
}

// Shift a detached content value. Custom messages and messages share the shape.
function shiftContent(content, shift, levelPattern) {
	if (!shift || !levelPattern) return structuredClone(content);
	if (typeof content === "string") return shiftText(content, shift, levelPattern);
	if (!Array.isArray(content)) return structuredClone(content);
	const copy = structuredClone(content);
	for (const block of copy) {
		if (typeof block?.text === "string") block.text = shiftText(block.text, shift, levelPattern);
	}
	return copy;
}

function shiftMessage(message, shift, levelPattern) {
	if (!shift || !levelPattern) return structuredClone(message);
	const copy = structuredClone(message);
	if (typeof copy.content === "string") copy.content = shiftText(copy.content, shift, levelPattern);
	else if (Array.isArray(copy.content)) {
		for (const block of copy.content) {
			if (typeof block?.text === "string") block.text = shiftText(block.text, shift, levelPattern);
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

function toolCallIds(message) {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	const ids = [];
	for (const block of message.content) {
		if (block?.type === "toolCall" && typeof block.id === "string") ids.push(block.id);
	}
	return ids;
}

/** Convert one persisted custom message to the AgentMessage a model reads. */
function customMessage(entry) {
	if (!contextCustomMessage(entry)) return null;
	const message = {
		role: "custom",
		customType: entry.customType,
		content: entry.content ?? "",
		display: entry.display !== false,
		timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
	};
	if (entry.details !== undefined) message.details = entry.details;
	return message;
}

/**
 * Convert entries that belong in model context, preserving their order.
 *
 * A tool call and every result for it must stay adjacent: a provider rejects
 * a custom boundary inserted between them. A nested batch writes its boundary
 * as the receipt's disk parent, so journal order is call → boundary → result;
 * the model must see call → result → boundary. Boundaries met while a tool
 * call is unresolved are therefore deferred until its results land.
 */
export function handoffMessages(entries) {
	const result = [];
	const deferred = [];
	let outstanding = new Set();
	const flush = () => {
		if (deferred.length > 0) result.push(...deferred.splice(0));
	};
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message?.role === "toolResult") {
				result.push(message);
				outstanding.delete(message.toolCallId);
				if (outstanding.size === 0) flush();
				continue;
			}
			flush();
			outstanding = new Set(toolCallIds(message));
			result.push(message);
			continue;
		}
		if (entry.type === "custom_message") {
			const message = customMessage(entry);
			if (message === null) continue;
			// A custom message is not a tool result: never land between a tool
			// call and its results.
			if (outstanding.size > 0) deferred.push(message);
			else result.push(message);
			continue;
		}
		if (entry.type !== "custom" || !/^scope\.(begin|end)$/.test(entry.customType)) continue;
		const boundary = {
			role: "custom",
			customType: entry.customType,
			content: JSON.stringify(entry.data ?? {}),
			display: false,
			timestamp: Date.now(),
		};
		if (outstanding.size > 0) deferred.push(boundary);
		else result.push(boundary);
	}
	flush();
	return result;
}

/**
 * Copy one source segment onto a recipient tail in a single atomic batch.
 *
 * The begin marker records the source range, the recipient tail, and the depth
 * shift, so a crash can retire the half copy and rewrite it from the journal
 * instead of guessing what it was. The caller must verify durable rollback and
 * exclude vibe for the entire transaction.
 *
 * `beforeWrite` runs inside the same batch, before the segment starts. Recovery
 * uses it to close the abandoned half copy with an abort marker, so retirement
 * and rewrite either both commit or neither does.
 */
export async function copyHandoff(sm, { tail = null, entries, handoffId, sourceBeginId, source, target = null, shift = 0, levelRegex, vibeInactive, durableAtomicWrites, adoptPins, beforeWrite }) {
	if (vibeInactive !== true) throw new Error("handoff requires confirmed inactive vibe runtime");
	if (durableAtomicWrites !== true || typeof sm.appendEntriesAtomically !== "function" || typeof sm.getSessionFile !== "function" || !sm.getSessionFile()) {
		throw new Error("handoff requires a persistent session with atomic writes");
	}
	if (!Number.isSafeInteger(handoffId) || handoffId < 0) throw new Error("invalid handoff id");
	if (!Number.isSafeInteger(shift)) throw new Error("invalid handoff shift");
	// A half copy is only rewritable when the record names what it copied, and
	// the range must describe exactly these entries: a mismatched range would
	// let recovery copy a different segment than the one the source produced.
	if (typeof source?.from !== "string" || source.from === "" || typeof source?.to !== "string" || source.to === "") {
		throw new Error("handoff requires its source range");
	}
	if (!Array.isArray(entries) || entries.length === 0) throw new Error("handoff requires its source segment");
	if (entries[0]?.id !== source.from || entries.at(-1)?.id !== source.to) {
		throw new Error("handoff source range does not match the copied entries");
	}
	const window = handoffWindow(entries);
	if (new Set(window.entries.map((entry) => entry.id)).size !== window.entries.length) throw new Error("duplicate handoff entry id");
	for (const entry of window.entries) mapId(entry.id, handoffId, new Set());
	// Read the source pins before the transaction. They travel outside the
	// journal segment: the source `scope.state` entries are never copied, and
	// the recipient's own state must stay its own.
	const pins = handoffPins(entries);
	const record = { handoffId, sourceBeginId, source: { from: source.from, to: source.to }, target: { tail }, context: { shift } };
	if (typeof target?.flowId === "string") record.target.flowId = target.flowId;
	if (typeof target?.label === "string") record.target.label = target.label;
	const result = await sm.appendEntriesAtomically(() => {
		if (typeof beforeWrite === "function") {
			const prelude = beforeWrite();
			if (prelude && typeof prelude.then === "function") throw new TypeError("beforeWrite requires a synchronous write");
		}
		const used = new Set(sm.getEntries().map((entry) => entry.id));
		const ids = new Map();
		for (const entry of window.entries) {
			const id = mapId(entry.id, handoffId, used);
			used.add(id);
			ids.set(entry.id, id);
		}
		selectLeaf(sm, tail);
		let current = sm.appendCustomEntry(HANDOFF_BEGIN, record);
		if (typeof current !== "string" || current === "") throw new Error("handoff aborted: the begin marker was not committed");
		const copied = [];
		if (window.summary !== undefined) {
			const message = { role: "custom", customType: "fission.compaction-summary", content: shiftText(window.summary, shift, levelRegex), display: false, details: { fissionCarry: "compaction-summary" }, timestamp: Date.now() };
			current = sm.appendMessage(message);
			if (typeof current !== "string" || current === "") throw new Error("handoff aborted: the compaction summary was not committed");
			copied.push({ type: "message", message });
		}
		for (const entry of window.entries) {
			const copy = { ...entry, id: ids.get(entry.id), parentId: current };
			delete copy.activeLeafId;
			if (entry.type === "message") copy.message = shiftMessage(entry.message, shift, levelRegex);
			if (entry.type === "custom_message") copy.content = shiftContent(entry.content, shift, levelRegex);
			if (entry.type === "label") copy.targetId = ids.get(entry.targetId) ?? entry.targetId;
			if (entry.type === "branch_summary") copy.fromId = ids.get(entry.fromId) ?? entry.fromId;
			if (entry.type === "custom" && entry.data?.beginToolCallId) {
				copy.data = { ...entry.data, beginToolCallId: ids.get(entry.data.beginToolCallId) ?? entry.data.beginToolCallId };
			}
			// Every write returns the id it committed. `undefined` is the host's
			// refusal (session or parent mismatch); chaining the next entry onto a
			// refused id would leave a half segment that looks committed.
			const written = sm.ingestReplicatedEntry(copy);
			if (typeof written !== "string" || written === "") throw new Error(`handoff aborted: entry ${String(copy.id)} was not committed`);
			if (written !== copy.id) throw new Error(`handoff aborted: entry ${String(copy.id)} was committed as ${written}`);
			current = written;
			copied.push(copy);
		}
		current = sm.appendCustomEntry(HANDOFF_END, { handoffId, count: copied.length });
		if (typeof current !== "string" || current === "") throw new Error("handoff aborted: the end marker was not committed");
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
 * Decide whether a half handoff can be rewritten from its own record.
 *
 * A record is replayable only when it names a source range, a recipient tail,
 * and a depth shift, and when the journal still agrees: the range must still be
 * connected, the tail must be where the half copy was written, and neither may
 * be part of the residue itself. A legacy marker stores none of this, and no
 * field is inferred for it: a guessed range would copy a segment the source
 * flow never produced.
 */
function assessReplay(handoff, entries, keptIds, drop) {
	const source = handoff.source;
	if (
		!source ||
		typeof source !== "object" ||
		typeof source.from !== "string" ||
		source.from === "" ||
		typeof source.to !== "string" ||
		source.to === ""
	) {
		return { replayable: false, replayReason: "the begin marker records no source range (legacy handoff)" };
	}
	const target = handoff.target;
	if (!target || typeof target !== "object" || !("tail" in target)) {
		return { replayable: false, replayReason: "the begin marker records no recipient tail (legacy handoff)" };
	}
	if ((target.tail ?? null) !== handoff.tail) {
		return { replayable: false, replayReason: "the recorded recipient tail is not where the half copy was written" };
	}
	if (target.tail !== null && !keptIds.has(target.tail)) {
		return { replayable: false, replayReason: "the recipient tail is itself uncommitted residue" };
	}
	if (!Number.isSafeInteger(handoff.shift)) {
		return { replayable: false, replayReason: "the begin marker records no depth shift (legacy handoff)" };
	}
	if (handoff.oneTail !== true) {
		return { replayable: false, replayReason: "the residue was written at more than one tail; retire it instead of rewriting" };
	}
	const segment = handoffSegment(entries, source.from, source.to);
	if (segment === null) {
		return { replayable: false, replayReason: "the recorded source range is no longer connected in the journal" };
	}
	if (segment.some((entry) => drop.has(entry.id))) {
		return { replayable: false, replayReason: "the recorded source range overlaps the residue" };
	}
	return { replayable: true, replayReason: null, segment };
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
			// Only the newest begin describes this attempt. Mixing fields across
			// retries would invent a record no copy ever wrote.
			source: last.data?.source ?? null,
			target: last.data?.target ?? null,
			shift: last.data?.context?.shift,
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
		const assessment = assessReplay(handoff, entries, keptIds, drop);
		handoff.replayable = assessment.replayable;
		handoff.replayReason = assessment.replayReason;
		if (assessment.segment !== undefined) handoff.segment = assessment.segment;
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
 * When the begin marker recorded its source range, recipient tail, and depth
 * shift, `retire: true` also rewrites the segment in the same atomic batch and
 * reports one `replay` entry per handoff (`copied`, `skipped`, or `failed`).
 * A legacy marker is retired only: its missing fields are never inferred. The
 * rewrite restores the journal, not a live recipient's messages, because no
 * flow agent survives the restart that requires this recovery.
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
	if (plan.handoffs.length === 0) return { recovered: [], dropped: [], retired: [], replay: [], kept: plan.kept };
	// An explicit `retire: true` must never delete a record, even when the host
	// also offers a bulk discard: deletion would drop the handoff without the
	// rewrite that delivers it. Honor the request and refuse when it cannot be
	// met in place.
	if (retire === true) {
		if (!plan.retirable) throw recoveryFailure("FISSION_RECOVERY_UNSAFE", plan.retireReason ?? "the residue cannot be retired in place");
		return retireIncompleteHandoffs(sm, plan, options);
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
		// The discard path removes the half copy through host calls that are not
		// part of one atomic batch, so a rewrite here could crash between the
		// removal and the copy and lose the record. Retire mode exists for that.
		replay: plan.handoffs
			.filter((handoff) => handoff.replayable)
			.map((handoff) => ({
				handoffId: handoff.handoffId,
				status: "skipped",
				reason: "the bulk discard path cannot rewrite a segment atomically; retire: true does both in one batch",
			})),
		kept: plan.kept,
	};
}

/**
 * Close every residue in place without removing a single entry, and rewrite the
 * ones whose record still names a complete source range.
 *
 * A lone begin marker is still handed to the host's discard, which removes it
 * cleanly. A larger residue is retired with an abort marker at its tail: the
 * copied entries stay in the journal, but the active branch no longer contains
 * them, so no context carries half a handoff. When the begin marker recorded its
 * source range, recipient tail, and depth shift, the same atomic batch that
 * writes the abort also writes the segment again, so retirement and rewrite
 * commit together. A record missing any of those fields describes a half copy
 * that cannot be rebuilt without inventing it: that one is retired only.
 *
 * A failed rewrite leaves the atomic batch uncommitted, and the residue is then
 * closed by the ordinary retirement path below. The failure is reported, not
 * hidden, and the next run can try again from the same record.
 */
function replayBlocker(sm, handoff, options) {
	if (handoff.replayable !== true) return handoff.replayReason ?? "the record cannot be replayed";
	if (options.vibeInactive !== true) return "the vibe runtime may own the atomic batch";
	if (typeof sm.appendEntriesAtomically !== "function" || typeof sm.ingestReplicatedEntry !== "function") {
		return "the host cannot rewrite a segment atomically";
	}
	if (handoff.shift !== 0 && options.levelRegex == null) return "the rewrite needs the level anchor to shift copied history";
	return null;
}

async function rewriteHandoff(sm, handoff, options) {
	try {
		const result = await copyHandoff(sm, {
			tail: handoff.tail,
			entries: handoff.segment,
			handoffId: handoff.handoffId,
			sourceBeginId: handoff.sourceBeginId,
			source: { from: handoff.source.from, to: handoff.source.to },
			target: handoff.target,
			shift: handoff.shift,
			levelRegex: options.levelRegex,
			vibeInactive: true,
			durableAtomicWrites: true,
			// The abort and the new segment share one batch: a crash cannot leave
			// a closed residue that nobody remembers how to rewrite.
			beforeWrite: () => {
				selectLeaf(sm, handoff.tail);
				const abortId = sm.appendCustomEntry(HANDOFF_ABORT, {
					handoffId: handoff.handoffId,
					beginIds: handoff.beginIds,
					retired: handoff.dropIds.length,
					replayed: true,
				});
				if (typeof abortId !== "string" || abortId === "") {
					throw recoveryFailure("FISSION_RECOVERY_INCOMPLETE", `handoff ${handoff.handoffId}: the host did not return an abort entry id`);
				}
			},
		});
		if (!result || typeof result.tail !== "string" || result.tail === "") {
			return { ok: false, reason: "the rewrite committed no segment" };
		}
		return { ok: true, tail: result.tail, entries: result.entries.length };
	} catch (error) {
		return { ok: false, reason: String(error?.message ?? error) };
	}
}

async function retireIncompleteHandoffs(sm, plan, options) {
	const dropped = [];
	const retired = [];
	const replay = [];
	const remove = typeof sm.discardEntryDurably === "function" ? (id) => sm.discardEntryDurably(id) : null;
	for (const handoff of plan.handoffs) {
		const blocker = replayBlocker(sm, handoff, options);
		if (blocker === null) {
			const rewritten = await rewriteHandoff(sm, handoff, options);
			if (rewritten.ok) {
				replay.push({ handoffId: handoff.handoffId, status: "copied", tail: rewritten.tail, entries: rewritten.entries });
				continue;
			}
			replay.push({ handoffId: handoff.handoffId, status: "failed", reason: rewritten.reason });
		} else {
			replay.push({ handoffId: handoff.handoffId, status: "skipped", reason: blocker });
		}
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
		replay,
		kept: remaining,
	};
}
