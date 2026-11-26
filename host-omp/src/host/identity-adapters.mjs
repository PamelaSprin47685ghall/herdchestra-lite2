// Host-side session adapters for the fork registry.
//
// The registry only needs three facts from a host context: who the agent is,
// which conversation a manager belongs to, and whether a station still owns
// the context's session. Everything here reads host objects; nothing here
// knows about forks.


/** The host's agent id for a context, or null. */
export function agentIdOf(ctx) {
	const direct = ctx?.agent?.id;
	if (typeof direct === "string" && direct !== "") return direct;
	const fallback = ctx?.agentId;
	return typeof fallback === "string" && fallback !== "" ? fallback : null;
}

/**
 * Whether a station still owns the context's session. The host keeps the
 * session manager on `ctx`; a branch manager proxy answers a different object
 * with the same session id, so compare the id when the objects differ.
 */
export function sameManager(station, ctx) {
	const key = ctx?.sessionManager ?? ctx;
	if (!key || !station?.manager) return false;
	if (station.manager === key) return true;
	try {
		const live = key.getSessionId?.();
		const armed = station.manager.getSessionId?.();
		return Boolean(live && armed && live === armed);
	} catch {
		return false;
	}
}

/**
 * The conversation key the ledger index is keyed by.
 *
 * A session id is the stable key across a branch manager proxy. Without one,
 * the manager object itself is the key: collapsing every id-less manager to
 * `null` makes unrelated sessions share one empty ledger, and a fork left in
 * that ledger becomes another session's unreceived child.
 */
export function conversationKeyOf(manager) {
	if (!manager || (typeof manager !== "object" && typeof manager !== "function")) {
		return null;
	}
	try {
		const id = manager.getSessionId?.();
		if (typeof id === "string" && id !== "") return `session:${id}`;
	} catch {
		// A throwing getter leaves the manager object as the key.
	}
	return manager;
}

