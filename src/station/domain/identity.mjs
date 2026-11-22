// Pure child identity and ledger resolution for fork wiring.
//
// The registry still owns the child-identity table: it is session state, not a
// request ledger. This module owns only the data shape and the ledger
// precedence. It never imports the Station or a host module, and never reads
// the live display holder's inner state. It may carry the two turn totals onto
// the chosen ledger when that ledger has no samples yet.

// The ledger precedence moved to src/station/domain/fork-ledger.mjs so the
// rule lives on the station side of the boundary and the wiring only executes
// it.

import { selectForkLedger } from "./fork-ledger.mjs";

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
 * Compatibility wrapper: the precedence rule lives in
 * `src/station/domain/fork-ledger.mjs`; callers that only need the ledger use
 * this function.
 */
export function resolveForkLedger(args = {}) {
	return selectForkLedger(args).ledger;
}


