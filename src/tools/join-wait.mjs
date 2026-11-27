/**
 * Join waits: the one place a caller parks for a returning subscope.
 *
 * The station takes a ready record in one synchronous beat. When none is ready,
 * this ticket parks on the registry queue until one arrives or the signal
 * aborts. Parking is a ticket concern, so the coroutines live here; the registry
 * keeps only the synchronous waiter queue they register into.
 */

import { notifyWaiters, openWaiter } from "../scope/fork-registry.mjs";
import { failure, subscribeLedger } from "../scope/ledger-charge.mjs";
import { openChildren, takeReady, unreceivedChildren } from "../scope/ledger-brackets.mjs";

/** Park one beat on the registry queue, releasing the waiter on wake or abort. */
async function park(registry, signal) {
	const waiter = openWaiter(registry, signal);
	try {
		return await waiter.promise;
	} finally {
		waiter.release();
	}
}

/**
 * Caller side: take the first returned subscope, parking until one arrives or
 * the signal aborts. Always checks `signal?.aborted` BEFORE `takeReady` so a
 * beat interrupted by abandon/user steer never consumes a ready result into
 * JOINED and drops it.
 */
export async function waitForReady(registry, ledger, options = {}) {
	subscribeLedger(ledger, (registry.wake ??= () => notifyWaiters(registry)));
	const ownerId = options.ownerId;
	const levelKey = options.levelKey;
	const signal = options.signal ?? null;
	const canTake = typeof options.canTake === "function" ? options.canTake : null;
	const admit = typeof options.admit === "function" ? options.admit : null;
	for (;;) {
		if (signal?.aborted) {
			return failure("JOIN_INTERRUPTED", "The join was interrupted; the forked scopes keep running.");
		}
		const guard = canTake ? canTake() : null;
		if (guard && guard.ok === false) return failure(guard.code, guard.reason);
		const taken = takeReady(ledger, { ownerId, levelKey, admit });
		if (taken.ok) return taken;
		if (taken.code === "NO_ADMISSIBLE_CHILD") {
			return failure("JOIN_CONTEXT_EXCEEDED", taken.reason, {
				blocked: taken.blocked,
			});
		}
		if (unreceivedChildren(ledger, ownerId).length === 0) {
			return failure("NO_UNRECEIVED_WORK", "No unreceived result remains.");
		}
		if (openChildren(ledger, ownerId).length === 0) {
			return failure("LEDGER_PAIRING_BROKEN", "Ready scope is missing from its queue.");
		}
		const woke = await park(registry, signal);
		if (woke?.ok === false) {
			return failure("JOIN_INTERRUPTED", "The join was interrupted; the forked scopes keep running.");
		}
	}
}
