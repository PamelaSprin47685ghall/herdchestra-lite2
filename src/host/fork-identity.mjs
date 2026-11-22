// Pure child identity and ledger resolution for fork wiring.
//
// The registry still owns the child-identity table: it is session state, not a
// request ledger. This module owns only the data shape and the ledger
// precedence. It never imports the Station or a host module, never mutates its
// inputs, and never reads the live display holder's inner state.

/**
 * Build the identity a child station reads back from the registry.
 *
 * `spec` is the fork registration data; `deps` are host capabilities captured
 * at spawn time. The display holder is carried as-is because it is a live slot:
 * a child created before the UI exists reads the same holder when the display
 * arrives. `targets` stays raw here; `setIdentity` normalizes it once.
 */
export function buildChildIdentity(spec = {}, deps = {}) {
	return {
		forkId: typeof spec.forkId === "string" ? spec.forkId : null,
		parentOwnerId:
			typeof spec.parentOwnerId === "string" ? spec.parentOwnerId : null,
		ownScopeId: typeof spec.ownScopeId === "string" ? spec.ownScopeId : null,
		intent: typeof spec.intent === "string" ? spec.intent : null,
		budget:
			spec.budget && typeof spec.budget === "object" ? { ...spec.budget } : null,
		time: Number.isFinite(spec.time) && spec.time > 0 ? spec.time : null,
		// The user owns the targets field; keep it on the identity. The registry
		// normalizes it in one place.
		targets: spec.targets ?? null,
		childDepth: Number.isInteger(spec.childDepth) ? spec.childDepth : null,
		agentId: typeof deps.agentId === "string" ? deps.agentId : null,
		display: deps.display ?? null,
		displayHolder: deps.displayHolder ?? null,
		ledger:
			deps.ledger && typeof deps.ledger === "object" ? deps.ledger : null,
		persistRoot:
			typeof deps.persistRoot === "function" ? deps.persistRoot : null,
	};
}

/**
 * Choose the ledger a station must use.
 *
 * Precedence, highest first:
 * 1. the identity's ledger (a child must use its fork's ledger);
 * 2. a live conversation index that already holds forks;
 * 3. the persisted bracket tree;
 * 4. the empty live index.
 *
 * A live station wins over an empty restored tree, and a restored tree wins
 * over a freshly created empty index. This is the precedence the wiring used
 * inline; it lives here so the rule is testable in one place.
 */
export function resolveForkLedger({ identity = null, indexed = null, restored = null } = {}) {
	if (identity?.ledger && typeof identity.ledger === "object") {
		return identity.ledger;
	}
	if (indexed && (indexed.order?.length ?? 0) > 0) return indexed;
	return restored ?? indexed ?? null;
}
