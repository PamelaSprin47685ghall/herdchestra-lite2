// Keep each request's skill receipt in the journal, live history, and output.
// A receipt belongs to one exact message prefix. Repeated context hooks reuse
// the committed receipt, including its clock and budget text.

import { createHash } from "node:crypto";
import { messagesOf } from "./adapter.mjs";

function sameMessage(left, right) {
	return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function branchMessages(manager) {
	const branch = manager.getBranch();
	if (!Array.isArray(branch)) throw new TypeError("The session branch is not an array.");
	return branch
		.filter((entry) => entry?.type === "message" && entry.message)
		.map((entry) => entry.message);
}

function appendToJournal(manager, message) {
	if (!manager || typeof manager.appendMessage !== "function") {
		throw new TypeError("The session manager cannot append messages.");
	}
	manager.appendMessage(message);
	// Some host managers silently discard writes after they close. A returned
	// entry id alone is not proof that the current branch contains the write.
	if (typeof manager.getBranch === "function") {
		if (!sameMessage(branchMessages(manager).at(-1), message)) {
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

function isSkill(message) {
	return message?.herdSkill === true;
}

function receiptStart(messages) {
	let index = messages.length;
	while (index > 0 && isSkill(messages[index - 1])) index -= 1;
	return index;
}

function turnKey(messages) {
	return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function lastTurnMessage(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isSkill(message) && message?.role !== "custom") return message;
	}
	return undefined;
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
	if (!sameMessage(lastTurnMessage(live.slice(0, start)), lastTurnMessage(prefix))) {
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
		const key = turnKey(prefix);
		const persisted = journal.at(-1);
		if (isSkill(persisted)) {
			// Existing sessions lack a turn key. Preserve their committed bytes
			// only when the message immediately before the receipt still agrees.
			// A later context transform may rewrite an older scope. When it
			// carries this exact committed receipt, it must keep that receipt
			// instead of assigning the projection a second turn identity.
			const matches = sameMessage(proposed, persisted) ||
				(typeof persisted.herdSkillTurn === "string"
					? persisted.herdSkillTurn === key
					: sameMessage(lastTurnMessage(journal), lastTurnMessage(prefix)));
			if (!matches) {
				throw new Error("The persisted receipt belongs to a different message prefix.");
			}
			receipt = persisted;
			reuse = true;
		} else {
			receipt = { ...proposed, herdSkillTurn: key };
		}
		if (live && !sameMessage(lastTurnMessage(live), lastTurnMessage(prefix))) {
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

function commitResult(result, ctx, managerFor) {
	if (!result || !Array.isArray(result.messages) || !isSkill(result.messages.at(-1))) {
		return result;
	}
	let manager;
	try {
		// A supplied resolver owns routing. Falling back after its failure can
		// put a flow's receipt on the owner's shared branch.
		manager = managerFor ? managerFor(ctx) : ctx?.sessionManager;
	} catch (error) {
		throw commitError("session lookup", error);
	}
	return { ...result, messages: commitSkillReceipt(manager, result.messages, ctx) };
}

/** Persist the receipt after either a synchronous or an asynchronous handler. */
export function hackContext(pi, handler, options = {}) {
	const managerFor =
		typeof options.managerFor === "function" ? options.managerFor : null;
	return pi.on("context", (event, ctx) => {
		const result = handler(event, ctx);
		if (result && typeof result.then === "function") {
			return Promise.resolve(result).then((settled) => commitResult(settled, ctx, managerFor));
		}
		return commitResult(result, ctx, managerFor);
	});
}
