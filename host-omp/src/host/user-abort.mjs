/**
 * Process-level user abort routing.
 *
 * The host enters here from two directions: a native user interrupt (Esc, ACP
 * cancel, Web UI abort) captured on the live session, and a host-level
 * `globalThis[USER_ABORT_KEY]` call issued before any station hook has seen the
 * context. Both must reach the engine that owns that context, and neither may
 * create a stray station.
 *
 * This is a host service, not wiring: it decides which engine answers. The
 * activation layer only registers it.
 */

import { releaseScopeReturnDrain } from "./branch-context.mjs";
import { registerUserAbortListener } from "./capture.mjs";
import { record } from "./diagnostics.mjs";
import {
	ABANDON_ABORT_REASON,
	CASCADE_ABORT_REASON,
	USER_ABORT_ENGINES_KEY,
	USER_ABORT_KEY,
} from "./process-symbols.mjs";

/**
 * Interrupt one live subscope because `scope_abandon` was called.
 * Distinct from `USER_ABORT` and `CASCADE_ABORT_REASON`: aborts the agent's
 * current beat and unwinds retry backoff so `spawnChildTicket` can immediately
 * drive its final `scope_return` turn.
 */
export function interruptChildSession(session) {
	if (!session) return;
	try {
		session?.agent?.abort?.(ABANDON_ABORT_REASON);
	} catch (error) {
		record("activation", error, { phase: "abandon-interrupt" });
	}
	try {
		if (typeof session.abort === "function") {
			const pending = session.abort();
			pending?.catch?.((error) => record("activation", error, { phase: "abandon-interrupt" }));
		}
	} catch (error) {
		record("activation", error, { phase: "abandon-interrupt" });
	}
}

/**
 * Stop one live child agent. The host owns the session shape; the core only
 * receives this closure through the fork wiring. A throwing abort must not
 * turn a cascade into an exception: the ledger already holds the reason.
 *
 * Stop `session.agent` synchronously first so any in-flight LLM call or tool
 * signal cuts immediately, then call `session.abort()` without a user-interrupt
 * label so retry backoff, prompt setup, bash, eval, and post-prompt tasks also
 * unwind without re-entering the user-abort cascade gate.
 */
export function abortChildSession(session) {
	if (!session) return;
	try {
		session?.agent?.abort?.(CASCADE_ABORT_REASON);
	} catch (error) {
		record("activation", error, { phase: "cascade-abort" });
	}
	try {
		if (typeof session.abort === "function") {
			const pending = session.abort();
			pending?.catch?.((error) => record("activation", error, { phase: "cascade-abort" }));
		}
	} catch (error) {
		record("activation", error, { phase: "cascade-abort" });
	}
}

/**
 * Route a host-level USER_ABORT (from native Esc via `AgentSession.prototype.abort`
 * or from the sibling Web UI extension) to the engine that owns `ctx` without
 * creating stray stations or letting a child activation overwrite the root.
 */
export function registerProcessUserAbortEngine(engine) {
	let engines = globalThis[USER_ABORT_ENGINES_KEY];
	if (!engines) {
		engines = new Set();
		Object.defineProperty(globalThis, USER_ABORT_ENGINES_KEY, {
			value: engines,
			enumerable: false,
			configurable: true,
		});
	}
	engines.add(engine);
	if (typeof globalThis[USER_ABORT_KEY] !== "function") {
		Object.defineProperty(globalThis, USER_ABORT_KEY, {
			value: (ctx, evidence = null) => {
				let matched = false;
				let lastResult;
				for (const candidate of [...engines]) {
					if (typeof candidate.hasStation === "function" && candidate.hasStation(ctx)) {
						matched = true;
						lastResult = candidate.userAbort?.(ctx, evidence);
					}
				}
				if (matched) return lastResult;
				// Fallback when a host invokes abort before any station hook saw `ctx`.
				const fallback = [...engines].at(-1);
				return fallback?.userAbort?.(ctx, evidence);
			},
			enumerable: false,
			configurable: true,
			writable: true,
		});
	}
	return registerUserAbortListener((session, evidence) => {
		if (typeof engine.hasStation === "function" && !engine.hasStation(session)) return;
		try {
			engine.userAbort?.(session, evidence);
		} catch (error) {
			record("activation", error, { phase: "session-user-abort" });
		} finally {
			releaseScopeReturnDrain(session);
		}
	});
}
