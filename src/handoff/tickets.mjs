// Handoff tickets: the only async entry points into the handoff flow.

import { debugLog } from "./debug.mjs";
import { performHandoff } from "./perform.mjs";
import { errorText, safeSession } from "./session.mjs";

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

/**
 * Model-call gate ticket: installed on `session.agent.addBeforeModelCallHook`.
 * Runs outside the host's 30s extension event-handler timeout budget so an
 * outbound LLM request starts or joins the handoff before context preparation.
 */
async function modelCallGateTicket(station, session, signal, context, ctx) {
	if (signal?.aborted) return;
	const relay = station.state.relay;
	const retry = relay?.handoffError && relay.lastLedger?.empty &&
		!relay.canStop && relay.firstEvaluation !== null;
	if (!station.handoffPromise && (relay?.handoffPending || retry)) {
		if (!relay.handoffPending) station.armHandoff();
		scheduleBackgroundHandoff(station, ctx, station.pi);
	}
	const barrier = station.handoffPromise;
	if (!barrier) {
		if (relay?.handoffPending || retry) {
			throw new Error("Relay handoff is pending without a completion barrier");
		}
		return;
	}
	debugLog("model_call_gate.wait", {
		generation: station.state.relay?.generation ?? null,
	});
	const outcome = await awaitWithAbort(barrier, signal);
	if (!outcome?.ok || outcome.inProgress) {
		throw new Error(`Relay handoff did not complete: ${outcome?.error ?? "handoff already in progress"}`);
	}
	if (signal?.aborted) return;

	const liveSession = session ?? station.handoffSession ?? null;
	const latestMessages = liveSession?.agent?.state?.messages;
	if (Array.isArray(context?.messages) && Array.isArray(latestMessages) && context.messages !== latestMessages) {
		context.messages.splice(0, context.messages.length, ...latestMessages);
	}
}

async function runBackgroundHandoff(station, ctx, pi, barrier, resolveBarrier) {
	let outcome;
	try {
		const session = safeSession(ctx) ?? station.handoffSession;
		await session?.settleInFlightMessagePersistence?.();
		outcome = await performHandoff(station, ctx, pi);
	} catch (error) {
		outcome = { ok: false, error: errorText(error) };
		debugLog("handoff.background_error", { error: errorText(error) });
		try {
			station.recordHandoffFailureAt(error, Date.now());
		} catch {
			// Best-effort error recording inside fire-and-forget shell.
		}
	} finally {
		if (station.handoffPromise === barrier) {
			station.handoffPromise = null;
		}
		station.handoffScheduled = false;
		resolveBarrier(outcome);
	}
}

export function installHandoffGate(station, ctx) {
	return station.ensureModelCallGate(ctx, modelCallGateTicket, safeSession(ctx));
}

/**
 * Schedule the real handoff completely outside the host's event handler
 * timeout budget via a macrotask timer with a catch-all safety shell.
 */
function scheduleBackgroundHandoff(station, ctx, pi) {
	if (station.handoffExecuting || station.handoffScheduled) {
		return false;
	}
	installHandoffGate(station, ctx);
	let resolveBarrier;
	const barrier = new Promise((resolve) => {
		resolveBarrier = resolve;
	});
	station.handoffPromise = barrier;
	station.handoffScheduled = true;
	setTimeout(() => {
		void runBackgroundHandoff(station, ctx, pi, barrier, resolveBarrier);
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
export function sessionStopTicket(station, ctx, pi) {
	const before = station.state.relay ?? null;
	debugLog("session_stop.enter", {
		mode: ctx?.mode ?? null,
		generation: before?.generation ?? null,
		handoffPending: before?.handoffPending ?? null,
		canStop: before?.canStop ?? null,
	});
	const scheduled = scheduleBackgroundHandoff(station, ctx, pi);
	debugLog("session_stop.exit", {
		fireAndForget: true,
		scheduled,
		generation: before?.generation ?? null,
	});
	return undefined;
}
