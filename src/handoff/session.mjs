// Handoff session: real AgentSession access, compaction counting, and
// short-branch recovery. No station state lives here.

import { retainedTailSetting, sessionFor } from "../host/capture.mjs";

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
	return /nothing to compact \(session too small\)/i.test(message);
}

function isCompactionBusy(error) {
	return /compaction already in progress/i.test(errorText(error));
}

/**
 * Wait for a background compaction that owns the session to settle. Handoff
 * compaction is itself background: another pass already rewriting history means
 * this barrier must wait, not fail and let a request through.
 */
async function waitForCompaction(session, timeoutMs = 120000) {
	const started = Date.now();
	try {
		while (session?.isCompacting) {
			if (Date.now() - started > timeoutMs) return false;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return true;
	} catch {
		return false;
	}
}

/** Run once; when a compaction pass already owns the session, wait and retry once. */
async function runWhenIdle(session, run) {
	try {
		return await run();
	} catch (error) {
		if (!isCompactionBusy(error)) throw error;
		if (!session?.isCompacting) throw error;
		if (!(await waitForCompaction(session))) throw error;
		return await run();
	}
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

/**
 * A manual handoff on a very small or already compacted branch fails with
 * "Nothing to hand off (already compacted)". Retry with a temporary smaller
 * retained tail. Never add messages to make the branch compressible.
 */
async function callHandoffWithRecovery(session, run) {
	const attempt = () => runWhenIdle(session, run);
	let firstError;
	try {
		return await attempt();
	} catch (error) {
		if (!isAlreadyCompacted(error)) throw error;
		firstError = error;
	}
	const settings = session?.settings;
	const setting = retainedTailSetting();
	if (settings && setting && typeof settings.hasRuntimeOverride === "function") {
		const previous = setting.get(settings);
		if (previous <= 1) throw firstError;
		const hadOverride = settings.hasRuntimeOverride(setting);
		setting.override(settings, 1);
		try {
			return await attempt();
		} finally {
			if (hadOverride) setting.override(settings, previous);
			else setting.clearOverride(settings);
		}
	}
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
		return await attempt();
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
	isCompactionBusy,
	waitForCompaction,
	callHandoffWithRecovery,
};
