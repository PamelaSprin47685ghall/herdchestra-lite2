// Dispatch the system handoff through the same call the built-in /handoff
// makes.
//
// oh-my-pi's /handoff is `session.compact(instructions, { mode: "handoff" })`:
// the builtin `handleCompact` and the RPC `handoff` command both call exactly
// that. The relay focus is the command's only argument; no prompt, user
// message, or developer message is sent. The call resolves only after the
// background compaction commits. `callHandoffWithRecovery` preserves the
// short-session retry that a manual /handoff gets.
//
// The commit and the relay generation advance are separate writes. The
// transaction record written by `armHandoff` carries the branch's handoff
// count; `performHandoff` verifies that count grew before advancing.

import { handoffFocus } from "../relay/index.mjs";
import { debugLog } from "./debug.mjs";
import {
	callHandoffWithRecovery,
	countHandoffCompactions,
} from "./session.mjs";

function sessionIdOf(session) {
	try {
		return session?.sessionManager?.getSessionId?.() ?? null;
	} catch {
		return null;
	}
}

function sameSession(expected, session) {
	if (!session || session.isDisposed === true) return false;
	if (session.isSessionTransitioning === true) return false;
	const live = sessionIdOf(session);
	return !expected || !live || expected === live;
}

export async function performHandoff(station, session) {
	if (!session) {
		throw new Error("Cannot resolve the live AgentSession for /handoff");
	}
	if (!station.state.relay?.handoffPending) {
		throw new Error("handoff is not pending");
	}
	station.ensureHandoffTarget(session);
	const relay = station.state.relay;
	const target = relay.handoffTarget ?? null;
	const expectedSessionId = target?.sessionId ?? station.handoffSessionId ?? null;
	if (!sameSession(expectedSessionId, session)) {
		throw new Error("The live session changed before /handoff could run");
	}
	const baseline = target?.baseline ?? countHandoffCompactions(session.sessionManager);
	const focus = handoffFocus(relay);
	debugLog("handoff.compact.start", {
		generation: relay.generation,
		sessionId: expectedSessionId,
		baseline,
	});
	const result = await callHandoffWithRecovery(session, () =>
		session.compact(focus, { mode: "handoff" }),
	);
	if (!sameSession(expectedSessionId, session)) {
		throw new Error("The live session changed while /handoff was compacting");
	}
	const after = countHandoffCompactions(session.sessionManager);
	if (baseline !== null && after !== null && after <= baseline) {
		throw new Error("handoff completed without a new handoff compaction entry");
	}
	if (!station.advanceRelayForHandoff({
		expectedGeneration: target?.fromGeneration ?? relay.generation,
	})) {
		throw new Error("handoff completed but relay did not advance");
	}
	debugLog("handoff.compact.commit", {
		generation: station.state.relay.generation,
		baseline,
		after,
	});
	return { ok: true, result };
}
