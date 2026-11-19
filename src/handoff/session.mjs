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

/**
 * A manual handoff on a very small or already compacted branch fails with
 * "Nothing to hand off (already compacted)". Retry with a temporary smaller
 * retained tail. Never add messages to make the branch compressible.
 */
async function callHandoffWithRecovery(session, focus) {
	let firstError;
	try {
		return await session.handoff(focus);
	} catch (error) {
		if (!isAlreadyCompacted(error)) throw error;
		firstError = error;
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
	if (!adjusted) throw firstError;
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
	callHandoffWithRecovery,
};
