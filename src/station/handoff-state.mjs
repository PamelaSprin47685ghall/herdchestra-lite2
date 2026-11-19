// Station handoff state transitions. The ticket owns the async flow; these
// synchronous functions own the relay state it leaves behind.

import { sessionFor } from "../host/capture.mjs";
import {
	applyLedgerEvaluation,
	beginGenerationAfterHandoff,
	handoffFocus,
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
	station.handoffFocus = handoffFocus({ ...relay, handoffPending: true });
	station.handoffAdvanced = false;
	station.handoffSwitched = false;
	station.state.relay = { ...relay, handoffPending: true };
	station.persist();
}

function advanceRelayForHandoff(station) {
	if (station.handoffAdvanced) return false;
	const relay = station.state.relay;
	if (!relay || !relay.handoffPending || relay.canStop) return false;
	station.state.relay = beginGenerationAfterHandoff(relay, {
		at: Date.now(),
		fromGeneration: relay.generation,
	});
	station.handoffAdvanced = true;
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


function markHandoffPending(station, ctx, options = {}) {
	const relay = station.state.relay;
	if (!relay) return { ok: false, error: "relay state is missing" };
	if (relay.canStop) {
		return { ok: true, skipped: "promoted", generation: relay.generation };
	}
	station.handoffFocus =
		options.focus ??
		handoffFocus({ ...relay, handoffPending: true });
	station.handoffSession = safeSessionFor(ctx) ?? station.handoffSession;
	station.registry.markPending(station);
	if (relay.handoffPending) {
		// applyLedgerEvaluation sets handoffPending itself. A new empty-ledger
		// decision arrives here with pending already true, so clear the previous
		// generation's completion flag before the stop gatekeeper advances.
		if (!station.handoffExecuting) {
			station.handoffAdvanced = false;
			station.handoffSwitched = false;
		}
		return {
			ok: true,
			pending: true,
			inProgress: true,
			generation: relay.generation,
		};
	}
	station.handoffAdvanced = false;
	station.handoffSwitched = false;
	station.state.relay = { ...relay, handoffPending: true, handoffError: null };
	station.persist();
	return {
		ok: true,
		pending: true,
		generation: station.state.relay.generation,
	};
}

export {
	armHandoff,
	advanceRelayForHandoff,
	recordLedgerEvaluation,
	recordHandoffFailureAt,
	markHandoffPending,
};
