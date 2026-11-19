// Handoff tickets: the only async entry points into the handoff flow.

import { appendHistoryMessage } from "../host/hack-context.mjs";
import { successorPrompt } from "../relay/index.mjs";
import { debugLog } from "./debug.mjs";
import { performHandoff } from "./perform.mjs";
import { errorText, managerOf, safeSession } from "./session.mjs";

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
	station.handoffWaiters += 1;
	debugLog("model_call_gate.wait", {
		waiters: station.handoffWaiters,
		generation: station.state.relay?.generation ?? null,
	});
	try {
		const outcome = await awaitWithAbort(barrier, signal);
		if (!outcome?.ok || outcome.inProgress) {
			throw new Error(`Relay handoff did not complete: ${outcome?.error ?? "handoff already in progress"}`);
		}
	} finally {
		station.handoffWaiters = Math.max(0, station.handoffWaiters - 1);
	}
	if (signal?.aborted) return;

	const liveSession = session ?? station.handoffSession ?? null;
	const latestMessages = liveSession?.agent?.state?.messages;
	if (Array.isArray(context?.messages) && Array.isArray(latestMessages) && context.messages !== latestMessages) {
		context.messages.splice(0, context.messages.length, ...latestMessages);
	}

	const target = station.relayPromptPendingFor;
	const successor = station.state.relay;
	if (
		Number.isInteger(target) &&
		station.relayPromptSentFor !== target &&
		successor?.generation === target &&
		Array.isArray(context?.messages)
	) {
		const message = {
			role: "user",
			content: [{ type: "text", text: successorPrompt(successor, successor.lastLedger) }],
			timestamp: Date.now(),
		};
		appendHistoryMessage(managerOf(liveSession, ctx), message, liveSession);
		if (!context.messages.includes(message)) context.messages.push(message);
		station.relayPromptSentFor = target;
		station.relayPromptPendingFor = null;
		station.persist();
		debugLog("model_call_gate.successor_injected", { generation: target });
	}
}

/**
 * Deliver the successor prompt asynchronously after background handoff finishes.
 * Uses the host's user-message / prompt channel so the successor starts a fresh
 * turn outside the timed event-handler callback.
 */
async function dispatchSuccessorToHost(station, ctx, pi) {
	const target = station.relayPromptPendingFor;
	if (!Number.isInteger(target) || station.relayPromptSentFor === target) {
		return false;
	}
	const relay = station.state.relay;
	if (!relay || relay.generation !== target) {
		return false;
	}
	const prompt = successorPrompt(relay, relay.lastLedger ?? null);
	const session = safeSession(ctx) ?? station.handoffSession ?? null;
	try {
		if (typeof pi?.sendUserMessage === "function") {
			station.relayPromptSentFor = target;
			station.relayPromptPendingFor = null;
			station.persist();
			await pi.sendUserMessage(prompt);
			debugLog("successor.dispatched", { via: "pi.sendUserMessage", generation: target });
			return true;
		}
		if (session && typeof session.sendUserMessage === "function") {
			station.relayPromptSentFor = target;
			station.relayPromptPendingFor = null;
			station.persist();
			await session.sendUserMessage(prompt);
			debugLog("successor.dispatched", { via: "session.sendUserMessage", generation: target });
			return true;
		}
		if (session && typeof session.prompt === "function") {
			station.relayPromptSentFor = target;
			station.relayPromptPendingFor = null;
			station.persist();
			await session.prompt(prompt);
			debugLog("successor.dispatched", { via: "session.prompt", generation: target });
			return true;
		}
	} catch (error) {
		station.relayPromptPendingFor = target;
		if (station.relayPromptSentFor === target) station.relayPromptSentFor = null;
		station.recordHandoffFailureAt(error, Date.now());
		debugLog("successor.dispatch_error", { error: errorText(error), generation: target });
	}
	return false;
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
	if (outcome?.ok && !outcome.inProgress && station.handoffWaiters === 0) {
		await dispatchSuccessorToHost(station, ctx, pi);
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
