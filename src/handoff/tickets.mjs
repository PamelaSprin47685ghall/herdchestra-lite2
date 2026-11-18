// Handoff tickets: the only async entry points into the handoff flow.

import {
	handoffFailureNudge,
	handoffPendingNudge,
} from "../relay/index.mjs";
import { continueFeedback } from "../tools/results.mjs";
import { debugLog } from "./debug.mjs";
import { deliverSuccessor, performHandoff } from "./perform.mjs";
import { errorText, managerOf, safeSession } from "./session.mjs";

/**
 * Session-stop handoff runner. Runs the real handoff once and turns the
 * outcome into the one continuation the host accepts; failure retries.
 */
async function runHandoffAtStop(station, ctx, pi) {
	const outcome = await performHandoff(station, ctx, pi);
	if (outcome?.inProgress) {
		return continueFeedback(handoffPendingNudge(station.state.relay));
	}
	if (outcome?.ok === false) {
		return continueFeedback(handoffFailureNudge(outcome.error));
	}
	return deliverSuccessor(station, ctx);
}

/**
 * Run the real handoff from the context hook, after the caller interrupts the
 * turn that would otherwise ask the model for a useless "ready to hand off"
 * reply. The context hook returns the post-handoff messages so the provider
 * request is already the successor's first turn. The TUI command path is
 * skipped because its command rebuilds the transcript and may re-enter the
 * active turn; the direct AgentSession.handoff() path still renders afterwards.
 */
export async function runHandoffInContext(station, ctx, pi) {
	const liveSession = safeSession(ctx) ?? station.handoffSession ?? null;
	const liveManager = managerOf(liveSession, ctx);
	if (liveManager && typeof liveManager.getBranch === "function") {
		try {
			const messageEntries = liveManager
				.getBranch()
				.filter((entry) => entry?.type === "message");
			// The host refuses a handoff before its second message. The tool
			// result is not on the branch yet, so a fresh session can only fail;
			// let session_stop retry after the turn appends its messages.
			if (messageEntries.length < 2) {
				return {
					ok: false,
					error:
						"too few messages for a context handoff; session_stop will retry",
				};
			}
		} catch {
			// Fall through to the real call.
		}
	}
	const outcome = await performHandoff(station, ctx, pi, { preferTui: false });
	if (outcome?.inProgress) {
		return { ok: false, pending: true, error: "handoff is already in progress" };
	}
	if (outcome?.ok === false) return { ok: false, error: outcome.error };
	return { ok: true, generation: outcome.generation };
}

/**
 * Session-stop ticket. The stop gatekeeper has already decided that a handoff
 * must run (relay.handoffPending or an empty ledger after arming); this ticket
 * performs it exactly once and yields the continuation. Only canStop, decided
 * by the gatekeeper, allows a natural stop.
 */
export async function sessionStopTicket(station, ctx, pi) {
	const before = station.state.relay ?? null;
	debugLog("session_stop.enter", {
		mode: ctx?.mode ?? null,
		generation: before?.generation ?? null,
		handoffPending: before?.handoffPending ?? null,
		canStop: before?.canStop ?? null,
	});
	station.sessionStopRunning = true;
	let result;
	try {
		result = await runHandoffAtStop(station, ctx, pi);
	} catch (error) {
		debugLog("session_stop.error", {
			error: errorText(error),
			generation: station.state.relay?.generation ?? null,
		});
		throw error;
	} finally {
		station.sessionStopRunning = false;
	}
	const after = station.state.relay ?? null;
	const context =
		typeof result?.additionalContext === "string"
			? result.additionalContext
			: "";
	debugLog("session_stop.exit", {
		continuation: result !== undefined,
		successorPromptDelivered: context.includes("You are the relay successor"),
		relayPromptSentFor: station.relayPromptSentFor ?? null,
		relayPromptPendingFor: station.relayPromptPendingFor ?? null,
		generation: after?.generation ?? null,
		handoffPending: after?.handoffPending ?? null,
		canStop: after?.canStop ?? null,
		handoffError: after?.handoffError ?? null,
	});
	return result;
}
