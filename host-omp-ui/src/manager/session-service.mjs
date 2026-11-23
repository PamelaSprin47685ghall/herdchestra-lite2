// Session service: turn "open this conversation" into either a live instance
// or one real tmux launch, with single-flight so a double click cannot start
// two omp processes for the same conversation.
//
// launch() only starts the process; registration with the manager is a later
// event. The caller must wait for that registration before treating the
// session as attached.

import {
	buildResumeLaunch,
	buildNewLaunch,
	mergeMachineSessions,
	resolveSessionTarget,
} from "./domain/session-catalog.mjs";

function isThenable(value) {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		typeof value.then === "function"
	);
}

function messageOf(error) {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	return "unknown error";
}

function failure(code, error) {
	return { ok: false, code, message: messageOf(error) };
}

function reused(live) {
	return { ok: true, kind: "reused", instanceId: live.instanceId };
}

/**
 * @param {{
 *   loadSessions: () => unknown[] | Promise<unknown[]>,
 *   findLiveInstance?: (sessionId: string) => unknown,
 *   launch: (plan: unknown, session: unknown) => unknown,
 *   buildPlan?: (session: unknown) => unknown,
 * }} deps
 */
export function createSessionService({ loadSessions, findLiveInstance, launch, buildPlan, buildNewPlan, awaitRegistration }) {
	if (typeof loadSessions !== "function") throw new TypeError("loadSessions is required");
	if (typeof launch !== "function") throw new TypeError("launch is required");

	/** @type {Map<string, Promise<object>>} */
	const inFlight = new Map();
	// Directories contributed by every concurrent request for one conversation.
	// They are kept beside the flight so a later caller cannot be starved by the
	// options of the request that happened to arrive first.
	/** @type {Map<string, Set<string>>} */
	const flightDirs = new Map();

	// A sync result is used without an await so that a caller that starts two
	// requests in one turn reaches launch before the next microtask turn.
	function lookupLive(sessionId) {
		if (typeof findLiveInstance !== "function") return null;
		const value = findLiveInstance(sessionId);
		return isThenable(value) ? Promise.resolve(value) : value;
	}

	function collectDirs(sessionId, options) {
		let dirs = flightDirs.get(sessionId);
		if (!dirs) {
			dirs = new Set();
			flightDirs.set(sessionId, dirs);
		}
		const extraDirs = Array.isArray(options?.extraDirs) ? options.extraDirs : [];
		for (const dir of extraDirs) {
			if (typeof dir === "string" && dir) dirs.add(dir);
		}
		return dirs;
	}

	async function runEnsure(sessionId, dirs) {
		let live;
		try {
			live = lookupLive(sessionId);
			if (isThenable(live)) live = await live;
			if (live && typeof live.instanceId === "string" && live.instanceId) return reused(live);

			// The directory set can grow while the scan is in flight. Load once,
			// and retry only when another request added a directory in the window
			// between taking the snapshot and the scan coming back empty.
			let sessions;
			let session;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const snapshot = [...dirs];
				sessions = loadSessions({ extraDirs: snapshot });
				if (isThenable(sessions)) sessions = await sessions;
				session = resolveSessionTarget(
					mergeMachineSessions(Array.isArray(sessions) ? sessions : []),
					sessionId,
				);
				if (session) break;
				if (dirs.size === snapshot.length) break;
			}
			if (!session) return { ok: false, code: "unknown_session" };

			// Close the window between reading the catalog and launching: another
			// process may have claimed the conversation in the meantime.
			live = lookupLive(sessionId);
			if (isThenable(live)) live = await live;
			if (live && typeof live.instanceId === "string" && live.instanceId) return reused(live);

			let plan;
			try {
				plan = typeof buildPlan === "function" ? buildPlan(session) : buildResumeLaunch({ session });
			} catch (error) {
				return failure(error?.code === "missing_cwd" ? "missing_cwd" : "launch_failed", error);
			}

			let started;
			try {
				started = await launch(plan, session);
			} catch (error) {
				return failure("launch_failed", error);
			}
			if (started?.ok === false) return failure(started.code || "launch_failed", started.message);
			const result = { ok: true, kind: "launched", ...(started?.instanceId ? { instanceId: started.instanceId } : {}) };
			if (typeof started.tmuxSession === "string" && started.tmuxSession) {
				result.tmuxSession = started.tmuxSession;
			}
			return result;
		} catch (error) {
			return failure("catalog_failed", error);
		}
	}

	/**
	 * @param {string} sessionId
	 * @param {{ extraDirs?: string[] }} [options] Directories registered by
	 *   every live instance; shared by the single flight for this conversation.
	 */
	function ensureSession(sessionId, options = {}) {
		const id = typeof sessionId === "string" ? sessionId.trim() : "";
		if (!id) return Promise.resolve({ ok: false, code: "unknown_session" });
		const dirs = collectDirs(id, options);
		const existing = inFlight.get(id);
		if (existing) return existing;

		const task = runEnsure(id, dirs);
		inFlight.set(id, task);
		// runEnsure never rejects; finally only releases the single-flight slot.
		task.finally(() => {
			if (inFlight.get(id) === task) {
				inFlight.delete(id);
				flightDirs.delete(id);
			}
		});
		return task;
	}

	const newFlights = new Map();
	function newSession({ cwd } = {}, waitForLaunch) {
		const existing = newFlights.get(cwd);
		if (existing) return existing;
		const task = (async () => {
			let plan;
			try { plan = buildNewPlan ? buildNewPlan({ cwd }) : buildNewLaunch({ cwd }); }
			catch (error) { return failure(error?.code || "launch_failed", error); }
			try {
				const started = await launch(plan);
				if (started?.ok === false) return failure(started.code || "launch_failed", started.message);
			} catch (error) { return failure("launch_failed", error); }
			try {
				const register = typeof waitForLaunch === "function" ? () => waitForLaunch(plan.launchId) : () => awaitRegistration?.(plan);
				const registered = await register();
				if (!registered?.instanceId || registered.ok === false || (registered.launchId && registered.launchId !== plan.launchId)) return failure("registration_failed", registered?.message || "registration failed");
				return { ok: true, kind: "launched", tmuxSession: plan.tmuxSession, cwd, instanceId: registered.instanceId, launchId: plan.launchId };
			} catch (error) { return failure("registration_failed", error); }
		})();
		newFlights.set(cwd, task);
		task.finally(() => { if (newFlights.get(cwd) === task) newFlights.delete(cwd); });
		return task;
	}
	return { ensureSession, newSession };
}
