// Station handoff state transitions. The ticket owns the async flow; these
// synchronous functions own the relay state it leaves behind.

import { sessionFor } from "../host/capture.mjs";
import {
	applyLedgerEvaluation,
	beginGenerationAfterHandoff,
	recordHandoffFailure,
} from "../relay/index.mjs";

function safeSessionFor(ctx) {
	try {
		return sessionFor(ctx);
	} catch {
		return null;
	}
}

function armHandoff(station) {
	const relay = station.state.relay;
	station.state.relay = { ...relay, handoffPending: true };
	station.persist();
}

function advanceRelayForHandoff(station) {
	const relay = station.state.relay;
	if (!relay || !relay.handoffPending || relay.canStop) return false;
	station.state.relay = beginGenerationAfterHandoff(relay, {
		at: Date.now(),
		fromGeneration: relay.generation,
	});
	station.persist();
	return true;
}

function recordLedgerEvaluation(station, phases, op, options = {}) {
	const applied = applyLedgerEvaluation(station.state.relay, phases, {
		op,
		...options,
	});
	station.state.relay = applied.relay;
	station.persist();
	return applied;
}

/** Record a failed handoff. The ticket owns the flow, the station owns state. */
function recordHandoffFailureAt(station, error, at) {
	station.state.relay = recordHandoffFailure(station.state.relay, error, { at });
	station.persist();
}


function rememberHandoffSession(station, ctx) {
	station.handoffSession = safeSessionFor(ctx) ?? station.handoffSession;
	station.registry.markPending(station);
}

export {
	armHandoff,
	advanceRelayForHandoff,
	recordLedgerEvaluation,
	recordHandoffFailureAt,
	rememberHandoffSession,
};
