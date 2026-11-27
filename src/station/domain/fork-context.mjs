// Two explicit value objects replace a dozen monkey-patched port fields.
//
// `ForkProcess` is the process-wide half. A host re-activates the extension for
// every session, and a parent and its child must agree on one registry, one
// ledger index and one display holder. Holding those on a plain object that the
// composition root owns makes the sharing a fact of the object graph instead of
// a `Symbol.for` slot on `globalThis`.
//
// `ForkContext` is the station-wide half: an immutable bundle of capabilities.
// A station reads `this.fork.ledger`, `this.fork.ownerId`, `this.fork.spawnChild`
// and never asks whether a capability happened to be attached later.
//
// Pure: no I/O, no clock, no station access.

import { buildChildIdentity } from "./identity.mjs";

export { buildChildIdentity };

/**
 * The process-wide fork container. One per extension process.
 *
	 * `ledgerByConversation` indexes the live tree per conversation, `runningByLedger`
	 * holds the per-ledger running set, and `states` holds the per-station attach
	 * record. All three are process-local and never persisted. A display holder is
	 * not among them: a display belongs to one station, and two sessions in one
	 * process must not paint into each other's sink.
	 */
	export function createForkProcess({ registry = null } = {}) {
		return {
			registry,
			ledgerByConversation: new Map(),
			runningByLedger: new WeakMap(),
			states: new WeakMap(),
		};
	}

// A station that no wiring ever attached reads this bundle: every capability
// answers the value a missing capability must answer, so a reader never probes.
const UNBOUND = Object.freeze({
	registry: null,
	ledger: null,
	identity: null,
	ownerId: null,
	depth: 0,
	contextWindow: null,
	reserve: undefined,
	margin: undefined,
	persistLedger: () => {},
	interruptScope: () => false,
	childOutcome: () => null,
	setChildOutcome: null,
	spawnChild: null,
	abortChildren: () => 0,
	display: null,
	setDisplay: () => {},
	noteRootWait: null,
	noteScopeRequest: null,
});

export function createUnboundForkContext() {
	return UNBOUND;
}

/**
 * Derive the capability bundle from plain inputs.
 *
 * Ownership, depth and persistence are derived here, not by the caller: an
 * identity with a `forkId` is a child, its `childDepth` is the depth when it is
 * a whole number, and a child with a `persistRoot` persists the tree through
 * it. `setChildOutcome` stays null for a root, because a root has no parent to
 * hand a rendered record to and a return there must not render one.
 */
export function createForkContext({
	registry = null,
	ledger = null,
	identity = null,
	contextWindow = null,
	reserve = undefined,
	margin = undefined,
	persistLedger = null,
	interruptScope = null,
	childOutcome = null,
	setChildOutcome = null,
	spawnChild = null,
	abortChildren = null,
	display = null,
	setDisplay = null,
	noteRootWait = null,
	noteScopeRequest = null,
} = {}) {
	const ownerId =
		typeof identity?.forkId === "string" && identity.forkId !== ""
			? identity.forkId
			: null;
	const depth = Number.isInteger(identity?.childDepth)
		? identity.childDepth
		: ownerId
			? 1
			: 0;
	const persist =
		typeof persistLedger === "function"
			? persistLedger
			: typeof identity?.persistRoot === "function"
				? identity.persistRoot
				: () => {};
	return Object.freeze({
		registry,
		ledger,
		identity,
		ownerId,
		depth,
		contextWindow,
		reserve,
		margin,
		persistLedger: persist,
		interruptScope:
			typeof interruptScope === "function" ? interruptScope : () => false,
		childOutcome: typeof childOutcome === "function" ? childOutcome : () => null,
		setChildOutcome:
			typeof setChildOutcome === "function" ? setChildOutcome : null,
		spawnChild,
		abortChildren:
			typeof abortChildren === "function" ? abortChildren : () => 0,
		display,
		setDisplay: typeof setDisplay === "function" ? setDisplay : () => {},
		noteRootWait,
		noteScopeRequest,
	});
}
