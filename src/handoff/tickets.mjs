// Handoff tickets: the only async entry points into the handoff flow.

import { debugLog } from "./debug.mjs";
import { performHandoff } from "./perform.mjs";
import { errorText, safeSession } from "./session.mjs";
import { trackRelayContinuation } from "../host/capture.mjs";

function awaitWithAbort(promise, signal) {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(
			signal.reason ?? new Error("Aborted while waiting for handoff"),
		);
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(signal.reason ?? new Error("Aborted while waiting for handoff"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function handoffAtBoundary(station, ctx) {
	if (!station.relayOn(ctx)) return null;
	const relay = station.state.relay;
	const retry = relay?.handoffError && relay.lastLedger?.empty &&
		!relay.canStop && relay.firstEvaluation !== null;
	if (!station.handoffPromise && (relay?.handoffPending || retry)) {
		if (!relay.handoffPending) station.armHandoff();
		scheduleBackgroundHandoff(station, ctx);
	}
	return station.handoffPromise;
}

// Older hosts can commit handoff in place while the model boundary waits.
async function modelCallGateTicket(station, session, signal, context, ctx) {
	if (signal?.aborted) return;
	const barrier = handoffAtBoundary(station, ctx);
	if (!barrier) return;
	debugLog("model_call_gate.wait", {
		generation: station.state.relay?.generation ?? null,
	});
	const outcome = await awaitWithAbort(barrier, signal);
	if (!outcome.ok) {
		throw new Error(`Relay handoff did not complete: ${outcome.error}`);
	}
	if (signal?.aborted) return;

	const liveSession = session ?? station.handoffSession ?? null;
	const latestMessages = liveSession?.agent?.state?.messages;
	if (Array.isArray(context?.messages) && Array.isArray(latestMessages) && context.messages !== latestMessages) {
		context.messages = latestMessages.slice();
	}
}

async function continueAfterHandoff(session, barrier, signal) {
	const epoch = session.transcriptEpoch;
	const outcome = await barrier;
	if (signal?.aborted || session.isDisposed || session.transcriptEpoch !== epoch) return;
	if (!outcome.ok) throw new Error(`Relay handoff did not complete: ${outcome.error}`);
	// The background commit has finished. No prompt or queued message is needed.
	if (!session.agent.state.isStreaming) await session.agent.continue(signal);
}

function yieldModelCallTicket(station, session, signal, ctx) {
	if (signal?.aborted) return;
	const barrier = handoffAtBoundary(station, ctx);
	if (!barrier) return;
	if (station.yieldedHandoff !== barrier) {
		station.yieldedHandoff = barrier;
		trackRelayContinuation(session, continueAfterHandoff(session, barrier, signal));
	}
	// Omp 19 background compaction cannot commit while this loop is parked.
	// Yield before provider dispatch, then continue without submitting text.
	return { stop: true, reason: "Relay handoff" };
}

async function runBackgroundHandoff(station, ctx, resolveBarrier) {
	let outcome;
	try {
		const session = safeSession(ctx) ?? station.handoffSession;
		await session?.settleInFlightMessagePersistence?.();
		outcome = await performHandoff(station, session);
	} catch (error) {
		outcome = { ok: false, error: errorText(error) };
		debugLog("handoff.background_error", { error: errorText(error) });
		try {
			station.recordHandoffFailureAt(error, Date.now());
		} catch {
			// Best-effort error recording inside fire-and-forget shell.
		}
	} finally {
		station.handoffPromise = null;
		resolveBarrier(outcome);
	}
}

export function installHandoffGate(station, ctx) {
	return station.ensureModelCallGate(ctx, modelCallGateTicket, yieldModelCallTicket, safeSession(ctx));
}

/**
 * Schedule the real handoff completely outside the host's event handler
 * timeout budget via a macrotask timer with a catch-all safety shell.
 */
function scheduleBackgroundHandoff(station, ctx) {
	if (station.handoffPromise) {
		return false;
	}
	const { promise, resolve } = Promise.withResolvers();
	station.handoffPromise = promise;
	setTimeout(() => {
		void runBackgroundHandoff(station, ctx, resolve);
	}, 0);
	debugLog("handoff.scheduled", {
		generation: station.state.relay?.generation ?? null,
	});
	return true;
}

/**
 * Session-stop ticket. The stop gatekeeper has already decided that a handoff
 * must run (relay.handoffPending or an empty ledger after arming). Dispatches
 * the real handoff as a fire-and-forget background task so the host's
 * `session_stop` handler returns immediately without hitting the callback timeout.
 */
export function sessionStopTicket(station, ctx) {
	const before = station.state.relay ?? null;
	debugLog("session_stop.enter", {
		mode: ctx?.mode ?? null,
		generation: before?.generation ?? null,
		handoffPending: before?.handoffPending ?? null,
		canStop: before?.canStop ?? null,
	});
	const scheduled = scheduleBackgroundHandoff(station, ctx);
	debugLog("session_stop.exit", {
		fireAndForget: true,
		scheduled,
		generation: before?.generation ?? null,
	});
	return undefined;
}
