// Handoff tickets: the only async entry points into the handoff flow.

import {
	successorPrompt,
} from "../relay/index.mjs";
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
 * outbound LLM request waits until an in-flight background handoff finishes
 * instead of advancing the old conversation.
 */
export async function modelCallGateTicket(station, session, signal, context) {
	const barrier = station.handoffPromise;
	if (!barrier) return;
	station.handoffWaiters += 1;
	debugLog("model_call_gate.wait", {
		waiters: station.handoffWaiters,
		generation: station.state.relay?.generation ?? null,
	});
	try {
		await awaitWithAbort(barrier, signal);
	} finally {
		station.handoffWaiters = Math.max(0, station.handoffWaiters - 1);
	}
	if (signal?.aborted) return;

	const liveSession = session ?? station.handoffSession ?? null;
	const latestMessages = liveSession?.agent?.state?.messages;
	if (Array.isArray(context?.messages) && Array.isArray(latestMessages)) {
		context.messages.splice(0, context.messages.length, ...latestMessages);
	}

	const target = station.relayPromptPendingFor;
	const relay = station.state.relay;
	if (
		Number.isInteger(target) &&
		station.relayPromptSentFor !== target &&
		relay &&
		relay.generation === target &&
		Array.isArray(context?.messages)
	) {
		const prompt = successorPrompt(relay, relay.lastLedger ?? null);
		station.relayPromptSentFor = target;
		station.relayPromptPendingFor = null;
		station.persist();
		context.messages.push({
			role: "user",
			content: [{ type: "text", text: prompt }],
			timestamp: Date.now(),
		});
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
	try {
		const outcome = await performHandoff(station, ctx, pi);
		if (outcome?.ok && !outcome.inProgress && station.handoffWaiters === 0) {
			await dispatchSuccessorToHost(station, ctx, pi);
		}
	} catch (error) {
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
		resolveBarrier();
	}
}

/**
 * Schedule the real handoff completely outside the host's event handler
 * timeout budget via a macrotask timer with a catch-all safety shell.
 */
export function scheduleBackgroundHandoff(station, ctx, pi) {
	if (station.handoffExecuting || station.handoffScheduled) {
		return false;
	}
	station.ensureModelCallGate(ctx, modelCallGateTicket, safeSession(ctx));
	let resolveBarrier;
	const barrier = new Promise((resolve) => {
		resolveBarrier = resolve;
	});
	station.handoffPromise = barrier;
	station.handoffScheduled = true;
	const timer = setTimeout(() => {
		void runBackgroundHandoff(station, ctx, pi, barrier, resolveBarrier);
	}, 0);
	if (typeof timer?.unref === "function") {
		timer.unref();
	}
	debugLog("handoff.scheduled", {
		generation: station.state.relay?.generation ?? null,
	});
	return true;
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
	const outcome = await performHandoff(station, ctx, pi);
	if (outcome?.inProgress) {
		return { ok: false, pending: true, error: "handoff is already in progress" };
	}
	if (outcome?.ok === false) return { ok: false, error: outcome.error };
	return { ok: true, generation: outcome.generation };
}

/**
 * Session-stop ticket. The stop gatekeeper has already decided that a handoff
 * must run (relay.handoffPending or an empty ledger after arming). Dispatches
 * the real handoff as a fire-and-forget background task so the host's
 * `session_stop` handler returns immediately without hitting the callback timeout.
 */
export function sessionStopTicket(station, ctx, pi) {
	const before = station.state.relay ?? null;
	station.ensureModelCallGate(ctx, modelCallGateTicket, safeSession(ctx));
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
