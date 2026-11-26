// The one-shot handle a stopped scope answers a scope_request through.
//
// A scope that finished its return keeps an idle handle only while its process
// lives; a scope whose session is gone (a reload, an abandoned handle) has
// none. The host can rebuild a session over the branch such a scope still
// owns, and this entry drives exactly one thing: answer what is queued, then
// let the scope die again. It never registers an idle entry and never touches
// the record, so a dead scope stays dead after the reply.

/** The turn a stopped scope is woken for. One reply, nothing else bound. */
export const COLD_REQUEST_WAKE =
	"A peer scope is waiting on your answer. Only `scope_reply` is bound this turn; answer in one string.";

/** How many reply turns one cold wake may spend before it gives up. */
const MAX_REPLY_TURNS = 3;

/**
 * Queued requests at one path.
 *
 * The queue owns the table; this only reads it, so a cold wake needs no import
 * from the module that mints entries.
 */
export function pendingAt(registry, path) {
	if (typeof path !== "string" || path === "") return 0;
	const map = registry?.requests;
	const queue = map && typeof map.get === "function" ? map.get(path) : null;
	return Array.isArray(queue) ? queue.length : 0;
}

/**
 * Wrap one resumed session as the idle-shaped entry `wakeIdleScope` drives.
 *
 * `prompt(text)` runs one turn, `pending()` counts the queue, and
 * `teardown()` stops the session and drops the identity the resume installed.
 * A request that arrives after teardown finds the record stopped again and
 * resumes a fresh session from the same `branchTail`.
 */
export function coldWakeEntry({ prompt, pending = () => 0, teardown = null } = {}) {
	let done = false;
	const stop = async () => {
		if (done) return;
		done = true;
		try {
			await teardown?.();
		} catch {
			// Teardown is best-effort: the reply already landed, or it never will.
		}
	};
	const drain = async () => {
		if (done) return false;
		if (typeof prompt !== "function" || pending() <= 0) {
			await stop();
			return false;
		}
		try {
			for (let turn = 0; turn < MAX_REPLY_TURNS; turn += 1) {
				await prompt(COLD_REQUEST_WAKE);
				if (pending() <= 0) break;
			}
		} finally {
			await stop();
		}
		return false;
	};
	return { prompt, drain, abort: stop, cold: true };
}
