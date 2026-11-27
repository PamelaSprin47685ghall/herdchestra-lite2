// Keep each request's skill receipt in the journal, live history, and output.
// A receipt belongs to one exact message prefix. Repeated context hooks reuse
// the committed receipt, including its clock and budget text.

import { createHash } from "node:crypto";
import { messagesOf } from "./adapter.mjs";
import {
	isSkill,
	journalOmits,
	lastTurnMessage,
	receiptStart,
	sameMessage,
	sameTurnMessage,
} from "./message-identity.mjs";

// The identity comparators have one owner: message-identity.mjs. These three
// stay exported here because the request-preparation path and its tests read
// them from the module that owns the commit.
export { journalOmits, sameAssistantFrame, samePersistedInputMessage } from "./message-identity.mjs";

function branchMessages(manager, options) {
	if (typeof manager.buildSessionContext === "function") {
		const messages = manager.buildSessionContext(options)?.messages;
		if (!Array.isArray(messages)) throw new TypeError("The session context has no message array.");
		return messages;
	}
	const branch = manager.getBranch();
	if (!Array.isArray(branch)) throw new TypeError("The session branch is not an array.");
	const messages = [];
	for (const entry of branch) {
		if (entry?.type === "message" && entry.message) messages.push(entry.message);
		else if (entry?.type === "custom_message") {
			messages.push({
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				attribution: entry.attribution,
				synthetic: entry.synthetic,
				excludeFromContext: entry.excludeFromContext,
				timestamp: typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : entry.timestamp,
			});
		} else if (["compaction", "branch_summary", "reset_boundary"].includes(entry?.type)) {
			// Rebuilding these entries requires the host's retained-history rules.
			// Never mistake an older receipt for the end of the current context.
			throw new TypeError("This session history requires buildSessionContext().");
		}
	}
	return messages;
}

function appendToJournal(manager, message) {
	if (!manager || typeof manager.appendMessage !== "function") {
		throw new TypeError("The session manager cannot append messages.");
	}
	manager.appendMessage(message);
	// Some host managers silently discard writes after they close. A returned
	// entry id alone is not proof that the current branch contains the write.
	if (typeof manager.getBranch === "function") {
		const branch = manager.getBranch();
		const stored = Array.isArray(branch)
			? branch.findLast((entry) => entry?.type === "message")?.message
			: undefined;
		if (!sameMessage(stored, message)) {
			throw new Error("The session branch did not retain the appended message.");
		}
	}
}

/**
 * Append one history message. A null source, or a host without live messages,
 * permits journal-only writes used by fold and handoff replay. If live history
 * exists, success requires both writes. Callers must handle a false result.
 */
export function appendHistoryMessage(manager, message, source = null) {
	try {
		const live = source ? messagesOf(source) : null;
		const needsLiveWrite = live && !live.includes(message);
		if (needsLiveWrite && !Object.isExtensible(live)) return false;
		appendToJournal(manager, message);
		if (needsLiveWrite) live.push(message);
		return true;
	} catch {
		return false;
	}
}

function turnKey(messages) {
	return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function commitError(phase, cause) {
	const error = new Error(`Context skill commit failed during ${phase}.`, { cause });
	error.code = "CONTEXT_SKILL_COMMIT_FAILED";
	error.phase = phase;
	return error;
}

function syncLiveReceipt(live, prefix, receipt) {
	if (!live) return;
	const start = receiptStart(live);
	if (!sameTurnMessage(lastTurnMessage(live.slice(0, start)), lastTurnMessage(prefix))) {
		throw new Error("Live history and the request end at different messages.");
	}
	if (start === live.length - 1 && live[start] === receipt) return;
	// Replace only the current unconsumed receipt run. Earlier receipts belong
	// to completed requests and must keep their original bytes and positions.
	live.splice(start, live.length - start, receipt);
}

/**
 * Commit a trailing skill receipt and return the canonical message list.
 * The caller can install a separate array copy into the host's running
 * context. This function never aliases that context with live agent history.
 */
export function commitSkillReceipt(manager, messages, source = null) {
	if (!Array.isArray(messages)) return messages;
	const proposed = messages.at(-1);
	if (!isSkill(proposed)) return messages;

	let journal;
	let live;
	try {
		if (!manager || typeof manager.getBranch !== "function") {
			throw new TypeError("The context manager cannot read its session branch.");
		}
		journal = branchMessages(manager);
		live = source ? messagesOf(source) : null;
	} catch (error) {
		throw commitError("session lookup", error);
	}

	const prefix = messages.slice(0, receiptStart(messages));
	let receipt;
	let reuse = false;
	try {
		const tail = lastTurnMessage(prefix);
		if (!sameTurnMessage(lastTurnMessage(journal), tail) && typeof manager.buildSessionContext === "function") {
			// The model projection drops aborted/failed turns; their journal
			// entries still witness the live tail. Never send this UI projection.
			const transcript = branchMessages(manager, { transcript: true });
			if (sameTurnMessage(lastTurnMessage(transcript), tail)) journal = transcript;
		}
		const key = turnKey(prefix);
		const persisted = journal.at(-1);
		if (isSkill(persisted)) {
			const carried = prefix.findLastIndex((message) => sameMessage(message, persisted));
			const suffix = carried < 0 ? [] : prefix.slice(carried + 1);
			const hasNewNote = suffix.length > 0 && suffix.every(journalOmits);
			// Existing sessions lack a turn key. Preserve their committed bytes
			// only when the message immediately before the receipt still agrees.
			// A later context transform may rewrite an older scope. When it
			// carries this exact committed receipt, it must keep that receipt
			// instead of assigning the projection a second turn identity.
			const sameTurn = typeof persisted.herdSkillTurn === "string"
				? persisted.herdSkillTurn === key
				: sameTurnMessage(lastTurnMessage(journal), lastTurnMessage(prefix));
			// The capability signature changes whenever the mode, the callable tool
			// set, the autopilot flag, or canStop changes, so one comparison now
			// covers what the three old booleans could only approximate. A receipt
			// written before the signature existed still regenerates on a legacy
			// field change instead of reusing stale bytes.
			const signatureChanged = (proposed.capSig ?? null) !== (persisted.capSig ?? null);
			const legacyChanged =
				proposed.capSig === undefined &&
				persisted.capSig === undefined &&
				((proposed.autopilot ?? null) !== (persisted.autopilot ?? null) ||
					(proposed.branch ?? null) !== (persisted.branch ?? null) ||
					(proposed.canStop ?? null) !== (persisted.canStop ?? null));
			const modeChanged = signatureChanged || legacyChanged;
			const replace = hasNewNote || (modeChanged && sameTurn);
			const matches = sameMessage(proposed, persisted) || sameTurn;
			if (!matches && !replace) {
				throw new Error("The persisted receipt belongs to a different message prefix.");
			}
			// A live-only note can follow the last journal receipt. Its presence
			// after that exact receipt proves a new request, not a stale replay.
			receipt = replace ? { ...proposed, herdSkillTurn: key } : persisted;
			reuse = !replace;
		} else {
			receipt = { ...proposed, herdSkillTurn: key };
		}
		if (!sameTurnMessage(lastTurnMessage(journal), tail)) {
			throw new Error("The journal and the request end at different messages.");
		}
		if (live && !sameTurnMessage(lastTurnMessage(live), tail)) {
			throw new Error("Live history and the request end at different messages.");
		}
	} catch (error) {
		throw commitError("prefix check", error);
	}

	try {
		if (!reuse) appendToJournal(manager, receipt);
	} catch (error) {
		throw commitError("journal write", error);
	}
	try {
		syncLiveReceipt(live, prefix, receipt);
	} catch (error) {
		// The journal may already contain the receipt. Stop this request. A
		// retry finds that receipt by its turn key and repairs live history
		// without writing a second copy or refreshing the clock text.
		throw commitError("live history write", error);
	}
	return [...prefix, receipt];
}

