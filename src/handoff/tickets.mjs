// Handoff tickets: the only async entry points into the relay handoff flow.
//
// The model-call ticket is the relay barrier. The host awaits
// `addBeforeModelCallHook` hooks inside the live run, before a request is
// built, so an empty ledger cannot become a request until the real system
// /handoff has committed. The same request then proceeds on the compacted
// transcript: no stop/continue dance, no extra model turn, and no blocking
// inside a host event callback.
//
// session_stop starts the same single-flight handoff in the background. It
// returns immediately (the host's event budget is never held), and only after
// the commit does it advance the relay and ask the agent to continue.

import { debugLog } from "./debug.mjs";
import { performHandoff } from "./perform.mjs";
import { errorText, safeSession } from "./session.mjs";

function retryable(relay) {
	return Boolean(
		relay &&
			!relay.canStop &&
			relay.handoffError &&
			relay.lastLedger?.empty &&
			relay.firstEvaluation !== null,
	);
}

/**
 * Start the one in-flight handoff, or join it. The station owns the promise
 * slot and records both outcomes; this ticket owns the async flow and never
 * lets a rejection escape the background shell.
 */
function startHandoff(station, session) {
	if (station.handoffPromise) return station.handoffPromise;
	const flow = (async () => {
		try {
			await performHandoff(station, session);
			return { ok: true };
		} catch (error) {
			const message = errorText(error);
			debugLog("handoff.error", { error: message });
			station.recordHandoffFailureAt(error, Date.now());
			return { ok: false, error: message };
		} finally {
			station.handoffPromise = null;
		}
	})();
	station.handoffPromise = flow;
	return flow;
}

function awaitWithAbort(promise, signal) {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(signal.reason ?? new Error("Aborted while waiting for handoff"));
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

/**
 * The model-call ticket. Synchronous until it must wait: it reads the relay,
 * arms the pending flag, opens (or joins) the handoff, and only then awaits.
 * A failed handoff rejects, so the request is never sent on a stale ledger.
 */
async function modelCallTicket(station, session, signal, context, ctx) {
	if (signal?.aborted) return;
	if (!station.relayOn(ctx)) return;
	const relay = station.state.relay;
	if (!relay || relay.canStop) return;
	if (!relay.handoffPending && !retryable(relay)) return;
	if (!relay.handoffPending) station.armHandoff();

	const active = safeSession(ctx) ?? session ?? station.handoffSession;
	if (!active) {
		throw new Error("Cannot resolve the live AgentSession for the system /handoff");
	}
	debugLog("model_call_gate.wait", {
		generation: station.state.relay?.generation ?? null,
	});
	const outcome = await awaitWithAbort(startHandoff(station, active), signal);
	if (signal?.aborted) return;
	if (!outcome.ok) {
		throw new Error(`Relay handoff did not complete: ${outcome.error}`);
	}
	const latest = active.agent?.state?.messages;
	if (Array.isArray(context?.messages) && Array.isArray(latest) && context.messages !== latest) {
		context.messages = latest.slice();
	}
}

/**
 * Resume the successor after a stop-triggered handoff. Never called before the
 * barrier resolves, and never when another run already owns the session.
 */
async function continueAfterStopHandoff(station, session) {
	const outcome = await startHandoff(station, session);
	if (!outcome.ok) return;
	if (session?.isDisposed) return;
	if (session?.agent?.state?.isStreaming) return;
	const agent = session?.agent;
	if (typeof agent?.continue !== "function") return;
	try {
		await agent.continue();
	} catch (error) {
		station.lastError = errorText(error);
	}
}

/**
 * Install the relay barrier on this agent. `addBeforeModelCallHook` iterates a
 * live set and is awaited by the host, so installing it inside a run takes
 * effect on that run's next request: the handoff cannot be missed.
 */
export function installRelayGate(station, ctx) {
	const session = safeSession(ctx) ?? station.handoffSession;
	return station.ensureModelCallGate(ctx, modelCallTicket, session);
}

/**
 * Session-stop ticket. The gatekeeper already decided a handoff is owed. This
 * ticket starts it in the background and returns synchronously, so the host's
 * `session_stop` handler never blocks. The successor continues only after the
 * commit; a failure stays recorded for the next boundary to retry.
 */
export function sessionStopTicket(station, ctx) {
	if (!station.relayOn(ctx)) return undefined;
	if (station.handoffPromise) return undefined;
	const relay = station.state.relay;
	if (!relay || relay.canStop) return undefined;
	if (!relay.handoffPending && !retryable(relay)) return undefined;
	if (!relay.handoffPending) station.armHandoff();
	const session = safeSession(ctx) ?? station.handoffSession;
	if (!session) return undefined;
	debugLog("session_stop.schedule", {
		generation: station.state.relay?.generation ?? null,
	});
	void continueAfterStopHandoff(station, session);
	return undefined;
}
