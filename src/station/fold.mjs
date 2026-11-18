// Station fold: fork the branch and collapse an elder sibling's interior.
// Pure host-session manipulation. No business state lives here.

import {
	collectPinnedMessages,
	findBegin,
	findToolCallIndex,
	finishedReport,
	isCollapsed,
	toolCalls,
} from "../transcript/index.mjs";
import { cloneMessage, finishedResultMessage } from "./messages.mjs";

function findBeginEntry(manager, beginToolCallId) {
	try {
		const branch = manager?.getBranch?.() ?? [];
		for (const entry of branch) {
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			if (toolCalls(entry.message).some((call) => call.id === beginToolCallId)) return entry;
		}
	} catch {
		// A manager without getBranch cannot fork; the caller reports the error.
	}
	return null;
}

function forkCollapse({ manager, collapse, begin, beginEntry, oldMessages, currentMessage, currentPersisted }) {
	if (
		!manager ||
		typeof manager.appendMessage !== "function" ||
		typeof manager.branch !== "function" ||
		!begin?.assistant
	) {
		return { ok: false, code: "FORK_UNAVAILABLE", reason: "The host session manager cannot append or branch messages." };
	}
	const endIndex = findToolCallIndex(oldMessages, collapse.endToolCallId);
	if (endIndex < 0 || endIndex <= begin.resultIndex) {
		return {
			ok: false,
			code: "SCOPE_BOUNDARY",
			reason: "The assistant message that ended the previous scope is not present on the current branch.",
		};
	}
	// The live assistant message may reach persistence after this hook. Replaying
	// it here would duplicate it, so stop at the persisted tail.
	const persistedEnd =
		currentPersisted === false &&
		currentMessage &&
		oldMessages[oldMessages.length - 1] === currentMessage
			? oldMessages.length - 1
			: oldMessages.length;
	if (persistedEnd <= endIndex) {
		return {
			ok: false,
			code: "SCOPE_BOUNDARY",
			reason: "The previous scope's end has no persisted tail to replay.",
		};
	}
	try {
		const parentId = beginEntry.parentId ?? null;
		if (parentId) {
			manager.branch(parentId);
		} else if (typeof manager.resetLeaf === "function") {
			manager.resetLeaf();
		} else {
			return { ok: false, code: "FORK_UNAVAILABLE", reason: "The scope begin is the root and resetLeaf is unavailable." };
		}
		manager.appendMessage(cloneMessage(begin.assistant));
		manager.appendMessage(
			finishedResultMessage(collapse.beginToolCallId, collapse.report, finishedReport),
		);
		const beginIds = new Set(toolCalls(begin.assistant).map((call) => call.id));
		for (let index = 0; index < endIndex; index += 1) {
			const message = oldMessages[index];
			if (
				message?.role === "toolResult" &&
				beginIds.has(message.toolCallId) &&
				message.toolCallId !== collapse.beginToolCallId
			) {
				manager.appendMessage(cloneMessage(message));
			}
		}
		// Replay the whole persisted tail from the previous scope's end onwards:
		// the most recently finished scope and the live turn stay byte-identical,
		// so their token prefix remains cacheable.
		const pinned = collectPinnedMessages(oldMessages, {
			start: begin.resultIndex + 1,
			end: endIndex,
			skipResultIds: beginIds,
		});
		let pinnedFlushed = pinned.length === 0;
		const flushPinned = () => {
			if (pinnedFlushed) return;
			pinnedFlushed = true;
			for (const message of pinned) manager.appendMessage(cloneMessage(message));
		};
		for (let index = endIndex; index < persistedEnd; index += 1) {
			if (index > endIndex && oldMessages[index]?.role !== "toolResult") {
				flushPinned();
			}
			manager.appendMessage(cloneMessage(oldMessages[index]));
		}
		flushPinned();
		return { ok: true };
	} catch (error) {
		return { ok: false, code: "FORK_FAILED", reason: String(error?.message ?? error) };
	}
}

/**
 * Fold an elder sibling into its begin receipt when it is still visible.
 *
 * Folding is presentation only. A record whose begin is no longer on the
 * current branch has already lost its interior, so mark it folded and let the
 * close proceed instead of failing on a message that cannot be shown.
 */
function foldElder({ manager, elder, base, currentMessage, currentPersisted }) {
	const begin = findBegin(base, elder.beginToolCallId);
	const beginEntry = begin ? findBeginEntry(manager, elder.beginToolCallId) : null;
	if (!begin || !beginEntry) {
		elder.collapsed = true;
		return { folded: false, report: null, rebased: false };
	}
	if (!isCollapsed(base, elder)) {
		const forked = forkCollapse({
			manager,
			collapse: elder,
			begin,
			beginEntry,
			oldMessages: base,
			currentMessage: currentMessage ?? null,
			currentPersisted,
		});
		if (!forked.ok) {
			elder.collapsed = true;
			return { folded: false, report: null, rebased: false };
		}
	}
	elder.collapsed = true;
	return { folded: true, report: elder.report, rebased: true };
}

export { findBeginEntry, forkCollapse, foldElder };
