/**
 * Process-wide state: one explicit owner, and one written policy per slot.
 *
 * The host binds this extension once per agent, and a fork tree spans agents. A
 * few facts must therefore outlive one extension instance. Each of them used to
 * be a bare `globalThis[Symbol.for(...)]` written by a different module, and two
 * of them disagreed about who wins when two instances race:
 *
 *   forkWiring   first writer wins — a child engine reuses the parent's registry,
 *                ledger and waiters, or the tree splits in two.
 *   statusState  first creator wins — and its owner clears the accumulated totals
 *                when a genuinely new root session starts.
 *   transcriptListeners
 *                first creator wins — every instance patches `subscribe`, so a
 *                second table would leave a child's frames unpainted by the
 *                instance that owns the display.
 *
 * None of these generalises: each is one policy, so each is stated once here
 * rather than rediscovered at a call site. The symbol keys themselves stay in
 * `process-symbols.mjs`: a key string is a published contract between two copies
 * of this package, and changing one stops an older copy matching silently.
 *
 * Nothing is cached in this module. Every accessor reads `globalThis`, so a test
 * that deletes a key resets that slot, and there is never a second source of
 * truth to fall out of step with the first.
 */
  import {
  	FORK_WIRING_KEY,
  	SESSION_CAPTURE_STATE,
  	STATUS_STATE,
  	TRANSCRIPT_LISTENERS,
  } from "./process-symbols.mjs";

/** The registry object itself. One per process, created on first use. */
const REGISTRY_KEY = Symbol.for("herdchestra-lite2.process-registry.v1");

/**
 * Claim one hidden slot on `globalThis`.
 *
 * Not enumerable, so the host's own view of `globalThis` stays clean; not
 * writable, so the only way to change it is to claim it again after deleting it,
 * which is what `resetProcessRegistry` does for a test.
 */
function claim(key, value) {
	Object.defineProperty(globalThis, key, {
		value,
		enumerable: false,
		configurable: true,
	});
	return value;
}

/**
 * The process-scoped registry.
 *
 * The same frozen object comes back on every call. A fresh process builds it on
 * first use; the accessors it carries never hold state of their own.
 */
export function getProcessRegistry() {
	return (
		globalThis[REGISTRY_KEY] ??
		claim(
			REGISTRY_KEY,
			Object.freeze({
				/**
				 * The one fork wiring for this process.
				 *
				 * First writer wins. A fork tree spans agents, and the host binds the
				 * extension again for every child session, so whichever engine starts
				 * first owns the registry, the ledger and the waiters for the tree; a
				 * later engine must adopt them, not replace them.
				 */
				forkWiring(wiring = null) {
					if (wiring && !globalThis[FORK_WIRING_KEY]) claim(FORK_WIRING_KEY, wiring);
					return globalThis[FORK_WIRING_KEY] ?? null;
				},

				/**
				 * The one status ledger for this process, created by the first caller.
				 *
				 * Every fork branch builds its own extension instance, so a
				 * per-instance ledger would split the session's totals once per flow.
				 * The ledger's owner clears the accumulated totals when a new root
				 * starts; that decision needs the ledger's own session records, so it
				 * stays in the status runtime.
				 */
				statusState(create) {
					const existing = globalThis[STATUS_STATE];
					return existing ?? claim(STATUS_STATE, create());
				},

				/**
				 * The one transcript listener table for this process.
				 *
				 * Each extension instance patches the session's `subscribe` and keeps the
				 * listeners it captured. A per-instance table would leave a child's frames
				 * unpainted by the instance that owns the display, and the owner's repaint
				 * would miss them; one table is what makes the arbiter's routing visible.
				 */
  				transcriptListeners(create) {
  					const existing = globalThis[TRANSCRIPT_LISTENERS];
  					return existing ?? claim(TRANSCRIPT_LISTENERS, create());
  				},

  				/**
  				 * The one capture record for this process.
  				 *
  				 * The prototype patches are installed once per process and the session
  				 * maps are keyed by host objects, so a per-instance record would lose the
  				 * binding a sibling instance captured. First creator wins; the record's
  				 * shape belongs to `capture.mjs`, the slot to this registry.
  				 */
  				captureState(create) {
  					const existing = globalThis[SESSION_CAPTURE_STATE];
  					return existing ?? claim(SESSION_CAPTURE_STATE, create());
  				},
  			}),
		)
	);
}

/**
 * Drop every slot this registry owns.
 *
 * Tests only: a live process never wants the fork tree it already built to
 * disappear. The keys are deleted, not replaced, so the next reader sees exactly
 * what a fresh process would.
 */
export function resetProcessRegistry() {
  	for (const key of [
  		REGISTRY_KEY,
  		FORK_WIRING_KEY,
  		STATUS_STATE,
  		TRANSCRIPT_LISTENERS,
  		SESSION_CAPTURE_STATE,
  	]) {
		delete globalThis[key];
	}
}
