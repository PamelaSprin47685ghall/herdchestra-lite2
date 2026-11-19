// Handoff tickets: the only async entry points into the relay handoff flow.
//
// The model-call gate is synchronous. It refuses the next provider request
// while a handoff is owed, starts the single-flight background ticket, and
// returns `{ stop: true }` immediately. The run ends; the ticket waits for
// `session.waitForRunEnd()`, runs the system handoff via `session.compact`, and
// advances the relay generation only after the compaction commit. The successor
// continues from `agent.continue()` after that commit. Nothing in a live run
// awaits the compaction, so the compaction boundary and the run cannot wait on
// each other.

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

function sameLiveSession(station, session) {
	if (!session || session.isDisposed === true) return false;
	if (session.isSessionTransitioning === true) return false;
	if (station.manager && session.sessionManager && session.sessionManager !== station.manager) {
		return false;
	}
	const expected = station.handoffSessionId;
	if (!expected) return true;
	try {
		const live = session.sessionManager?.getSessionId?.();
		return !live || live === expected;
	} catch {
		return false;
	}
}

async function waitForRunEnd(session) {
	if (typeof session?.waitForRunEnd === "function") {
		await session.waitForRunEnd();
		return;
	}
	if (typeof session?.waitForIdle === "function") await session.waitForIdle();
}

/**
 * Start the one in-flight handoff, or join it. The station owns the promise
 * slot and records both outcomes; this ticket owns the async flow and never
 * lets a rejection escape the background shell.
 */
function startHandoff(station, session) {
	if (station.handoffPromise) return station.handoffPromise;
	if (station.recoverHandoffCommit(session)) {
		return Promise.resolve({ ok: true, recovered: true });
	}
	const flow = (async () => {
		try {
			await waitForRunEnd(session);
			if (!sameLiveSession(station, session)) {
				throw new Error("The live session changed before /handoff could start");
			}
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

/**
 * Resume the successor after a stop-triggered handoff. Never called before the
 * barrier resolves, and never when the session has moved on. One generation
 * yields at most one continuation even when the gate and the stop hook both
 * join the same handoff.
 */
function continueAfterStopHandoff(station, session) {
	// Do not compare against the current generation here: a successor that
	// already continued is exactly the holder that can arm the NEXT handoff at
	// that same generation. The post-commit check below is the one that makes
	// the continuation single-flight.
	const flow = (async () => {
		const outcome = await startHandoff(station, session);
		if (!outcome.ok) return;
		if (!sameLiveSession(station, session)) return;
		if (session?.agent?.state?.isStreaming) return;
		const agent = session?.agent;
		if (typeof agent?.continue !== "function") return;
		const nextGeneration = station.state.relay?.generation ?? 0;
		if (station.successorStartedGeneration === nextGeneration) return;
		station.successorStartedGeneration = nextGeneration;
		try {
			await agent.continue();
		} catch (error) {
			station.successorStartedGeneration = null;
			station.lastError = errorText(error);
		}
	})();
	return flow;
}

/**
 * The model-call gate. Synchronous: it reads the relay, arms the transaction,
 * starts the single-flight ticket, and refuses the request without awaiting the
 * compaction. The host runs it immediately before the provider call, so no
 * request can be built on the empty ledger.
 */
function modelCallGate(station, session, _context, signal, ctx) {
	if (signal?.aborted) return undefined;
	if (!station.relayOn(ctx)) return undefined;
	const relay = station.state.relay;
	if (!relay || relay.canStop) return undefined;
	if (!relay.handoffPending && !retryable(relay)) return undefined;
	const active = safeSession(ctx) ?? session ?? station.handoffSession ?? null;
	if (!active) return undefined;
	station.handoffSession = active;
	if (!station.state.relay.handoffPending) station.armHandoff(ctx);
	if (!station.state.relay.handoffTarget) station.ensureHandoffTarget(active);
	void continueAfterStopHandoff(station, active);
	return {
		stop: true,
		reason:
			"RELAY_HANDOFF_PENDING: the system /handoff is committing. This request is refused; the successor continues after the commit.",
	};
}

/**
 * Install the relay gate on this agent. `addBeforeModelCall` gates are sampled
 * when a run starts, so installing the gate in `before_agent_start` takes
 * effect on that run's requests, including the next request after an empty
 * ledger.
 */
export function installRelayGate(station, ctx) {
	const session = safeSession(ctx) ?? station.handoffSession ?? null;
	if (session) station.handoffSession = session;
	return station.ensureModelCallGate(ctx, modelCallGate, session);
}

/**
 * Session-stop ticket. The gatekeeper already decided a handoff is owed. This
 * ticket starts it in the background and returns synchronously, so the host's
 * `session_stop` handler never blocks. The successor continues only after the
 * commit; a failure stays recorded for the next boundary to retry.
 */
export function sessionStopTicket(station, ctx) {
	if (!station.relayOn(ctx)) return undefined;
	const relay = station.state.relay;
	if (!relay || relay.canStop) return undefined;
	if (!relay.handoffPending && !retryable(relay)) return undefined;
	const session = safeSession(ctx) ?? station.handoffSession ?? null;
	if (!session) return undefined;
	station.handoffSession = session;
	if (!station.state.relay.handoffPending) station.armHandoff(ctx);
	if (!station.state.relay.handoffTarget) {
		station.ensureHandoffTarget(session);
	}
	void continueAfterStopHandoff(station, session);
	return undefined;
}
