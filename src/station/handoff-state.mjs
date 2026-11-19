// Station handoff state transitions. The ticket owns the async flow; these
// synchronous functions own the relay state it leaves behind.
//
// The handoff transaction is recorded before the compaction starts: session id,
// branch handoff count, and source generation. A later count above that
// baseline proves the compact committed even if the relay advance was
// interrupted, so recovery advances the generation instead of compacting a
// second time.

import { countHandoffCompactions } from "../handoff/session.mjs";
import { debugLog } from "../handoff/debug.mjs";
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

function sessionIdOf(session) {
	try {
		return session?.sessionManager?.getSessionId?.() ?? null;
	} catch {
		return null;
	}
}

function handoffCountOf(session) {
	return countHandoffCompactions(session?.sessionManager ?? null);
}

/**
 * Arm one handoff and record its transaction target in the same synchronous
 * state transition that flips `handoffPending`.
 */
function armHandoff(station, ctx) {
	const relay = station.state.relay;
	if (!relay || relay.canStop) return false;
	const session = safeSessionFor(ctx) ?? station.handoffSession ?? null;
	if (session) station.handoffSession = session;
	const sessionId = sessionIdOf(session) ?? station.handoffSessionId ?? null;
	station.handoffSessionId = sessionId;
	const existing = relay.handoffTarget;
	const baseline = existing?.baseline ?? handoffCountOf(session);
	station.state.relay = {
		...relay,
		handoffPending: true,
		handoffTarget: {
			sessionId,
			baseline,
			fromGeneration: existing?.fromGeneration ?? relay.generation,
			at: existing?.at ?? Date.now(),
		},
	};
	station.persist();
	station.registry?.markPending?.(station);
	return true;
}

/** Fill a transaction target restored without one before the compaction starts. */
function ensureHandoffTarget(station, session) {
	const relay = station.state.relay;
	if (!relay?.handoffPending) return false;
	if (relay.handoffTarget) return true;
	const sessionId = sessionIdOf(session) ?? station.handoffSessionId ?? null;
	station.handoffSessionId = sessionId;
	station.state.relay = {
		...relay,
		handoffTarget: {
			sessionId,
			baseline: handoffCountOf(session),
			fromGeneration: relay.generation,
			at: Date.now(),
		},
	};
	station.persist();
	return true;
}

function advanceRelayForHandoff(station, options = {}) {
	const relay = station.state.relay;
	if (!relay || !relay.handoffPending || relay.canStop) return false;
	const expected = options.expectedGeneration;
	if (Number.isInteger(expected) && expected !== relay.generation) return false;
	station.state.relay = beginGenerationAfterHandoff(relay, {
		at: Number.isFinite(options.at) ? options.at : Date.now(),
		fromGeneration: relay.generation,
	});
	station.persist();
	return true;
}

/**
 * Recognize a handoff that already committed but whose relay advance was
 * interrupted. The caller must then start a fresh successor request instead of
 * compacting again.
 */
function recoverHandoffCommit(station, session) {
	const relay = station.state.relay;
	const target = relay?.handoffTarget;
	if (!relay?.handoffPending || !target || target.baseline === null) return false;
	const liveId = sessionIdOf(session);
	if (target.sessionId && liveId && target.sessionId !== liveId) return false;
	const after = handoffCountOf(session);
	if (after === null || after <= target.baseline) return false;
	const advanced = advanceRelayForHandoff(station, {
		expectedGeneration: target.fromGeneration,
		at: Date.now(),
	});
	if (advanced) {
		debugLog("handoff.recover", {
			generation: station.state.relay.generation,
			fromGeneration: target.fromGeneration,
			after,
		});
	}
	return advanced;
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

export {
	armHandoff,
	ensureHandoffTarget,
	advanceRelayForHandoff,
	recoverHandoffCommit,
	recordLedgerEvaluation,
	recordHandoffFailureAt,
	sessionIdOf,
	safeSessionFor,
};
