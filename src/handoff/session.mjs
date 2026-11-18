// Handoff session: real AgentSession access, compaction counting, and
// short-branch recovery. No station state lives here.

import { sessionFor } from "../host/capture.mjs";

const KEEP_RECENT_KEY = "compaction.keepRecentTokens";

function safeSession(ctx) {
	try {
		return sessionFor(ctx);
	} catch {
		return null;
	}
}

function errorText(error) {
	return String(error?.message ?? error ?? "handoff failed");
}

function isAlreadyCompacted(error) {
	const message = errorText(error);
	if (/already compacted/i.test(message)) return true;
	return /nothing to hand off/i.test(message) && !/no messages yet/i.test(message);
}

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

function managerOf(session, ctx) {
	try {
		if (session?.sessionManager) return session.sessionManager;
	} catch {
		// Fall through to the extension context.
	}
	try {
		return ctx?.sessionManager ?? null;
	} catch {
		return null;
	}
}

function appendHandoffCheckpoint(session) {
	const manager = session?.sessionManager;
	if (!manager || typeof manager.appendMessage !== "function") return false;
	const message = {
		role: "user",
		content: [
			{
				type: "text",
				text: "Relay handoff audit checkpoint. The previous holder's ledger was empty; the successor must verify it with todo.",
			},
		],
		timestamp: Date.now(),
	};
	try {
		manager.appendMessage(message);
	} catch {
		return false;
	}
	// The compaction reads the live agent transcript, not only the session
	// manager. Keep them aligned, or the checkpoint never forms a compressible
	// tail and the retry fails with "already compacted" again.
	try {
		const messages = session?.agent?.state?.messages;
		if (Array.isArray(messages) && !messages.includes(message)) {
			messages.push(message);
		}
	} catch {
		// A host without a live agent still got the manager entry.
	}
	return true;
}

/**
 * A manual handoff on a very small or already compacted branch fails with
 * "Nothing to hand off (already compacted)". First append a real user
 * checkpoint: it forms a compressible tail without changing settings. Only if
 * that still fails, re-run with a temporary keepRecentTokens=1 and restore the
 * user's setting in `finally`. Never make the change permanent.
 */
async function callHandoffWithRecovery(session, focus) {
	let firstError;
	try {
		return await session.handoff(focus);
	} catch (error) {
		if (!isAlreadyCompacted(error)) throw error;
		firstError = error;
	}
	let checkpointError = null;
	if (appendHandoffCheckpoint(session)) {
		try {
			return await session.handoff(focus);
		} catch (error) {
			if (!isAlreadyCompacted(error)) throw error;
			checkpointError = error;
		}
	}
	const settings = session?.settings;
	const canAdjust =
		settings &&
		typeof settings.get === "function" &&
		typeof settings.set === "function";
	const previous = canAdjust ? settings.get(KEEP_RECENT_KEY) : undefined;
	let adjusted = false;
	if (canAdjust) {
		try {
			settings.set(KEEP_RECENT_KEY, 1);
			adjusted = true;
		} catch {
			// No setting change means no third attempt.
		}
	}
	if (!adjusted) throw checkpointError ?? firstError;
	try {
		return await session.handoff(focus);
	} finally {
		try {
			settings.set(KEEP_RECENT_KEY, previous);
		} catch {
			// Restore is best effort; the real error is already surfaced.
		}
	}
}

export {
	KEEP_RECENT_KEY,
	safeSession,
	errorText,
	isAlreadyCompacted,
	managerOf,
	appendHandoffCheckpoint,
	callHandoffWithRecovery,
};
