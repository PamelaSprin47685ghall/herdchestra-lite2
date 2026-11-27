// The rewind and model-switch state machine, as one value with total
// transitions.
//
// The station used to keep four independent facts about a rewind
// (`pendingChildRewind`, `childRewindAvailable`, `rewoundThisTurn`,
// `rewindDispatching`) plus two about a model switch (`pendingModelSwitch`,
// `modelSwitchInFlight`) as loose fields. Nothing owned them together, so the
// double-dispatch guard and the child rewind permission were each re-derived at
// every call site. One object with named transitions makes each invariant a
// property of a function instead of a convention.
//
// Pure: every function takes the state it transitions and returns what the
// caller needs; none of them read a station, a clock or a host.

export function createRewindState() {
	return {
		// The staged child rewind plan, or null when the child must stay put.
		pendingChild: null,
		// False once the host proved it cannot branch, so the child rewind is
		// refused instead of half-attempted.
		childAvailable: true,
		// True between a rewind commit and the end of that turn.
		rewoundThisTurn: false,
		// The exact pending object a host rewind is currently dispatching, used
		// as a reference identity so a second report of the same event cannot
		// start a second dispatch.
		dispatching: null,
		// A scoped model switch the host still has to perform, and the one in
		// flight while it does.
		modelSwitch: null,
		modelSwitchInFlight: null,
	};
}

// -- Root rewind -----------------------------------------------------------

/** True when this exact pending object is already being dispatched. */
export function rootDispatchBusy(state, plan) {
	return state.dispatching !== null && state.dispatching === plan?.pending;
}

export function markRootDispatch(state, pending) {
	state.dispatching = pending ?? null;
}

/**
 * Settle a root rewind after a commit attempt.
 *
 * A commit that landed, or a dispatch whose plan is the one in flight, clears
 * the dispatch marker: leaving it set would make the next event look like a
 * duplicate of a rewind that already finished.
 */
export function settleRootRewind(state, plan, committed) {
	if (committed === true || (plan && state.dispatching === plan.pending)) {
		state.dispatching = null;
	}
	// `rewoundThisTurn` survives the commit: the stop nudge that follows the
	// replaced turn must still know a rewind happened. Only an abort or an
	// external session transition clears it (`clearRootRewind`).
	return committed === true;
}

/** Clear the marker after an abort or an external session transition. */
export function clearRootRewind(state) {
	state.dispatching = null;
	state.rewoundThisTurn = false;
}

// -- Child rewind ----------------------------------------------------------

/**
 * A child rewind needs a branch and a leaf reset on the manager. Without both,
 * the scope would report a rewind the host cannot perform.
 */
export function childRewindPermitted(state, manager) {
	return (
		state.childAvailable !== false &&
		typeof manager?.branch === "function" &&
		typeof manager?.resetLeaf === "function"
	);
}

/** Refuse every future child rewind; the host proved it cannot branch. */
export function disableChildRewind(state) {
	state.childAvailable = false;
	return state;
}

/**
 * Stage the plan the spawn ticket will consume: the generation report, the
 * generation number it was cut at, and the tool call that asked for it.
 */
export function stageChildRewind(state, { report, generation, id = "", big = false }) {
	state.pendingChild = { report, big, generation, id };
	return state.pendingChild;
}

export function hasPendingChildRewind(state) {
	return state.pendingChild !== null;
}

/**
 * Take the staged plan and clear the slot in the same synchronous step, so a
 * second consumer of the same return cannot rewind twice.
 */
export function consumeChildRewind(state) {
	const plan = state.pendingChild;
	state.pendingChild = null;
	return plan;
}

// -- Model switch ----------------------------------------------------------

/** True while a switch is queued or running; new observations must not queue. */
export function modelSwitchBusy(state) {
	return state.modelSwitchInFlight !== null || state.modelSwitch !== null;
}

export function queueModelSwitch(state, request) {
	state.modelSwitch = request;
	return request;
}

/** Take the queued request into flight; a busy machine yields null. */
export function takeModelSwitch(state) {
	if (state.modelSwitchInFlight !== null) return null;
	const request = state.modelSwitch;
	state.modelSwitch = null;
	state.modelSwitchInFlight = request;
	return request;
}

/** Clear the in-flight slot only when it is the request that just settled. */
export function settleModelSwitch(state, request) {
	if (state.modelSwitchInFlight !== null && state.modelSwitchInFlight === request) {
		state.modelSwitchInFlight = null;
	}
}
