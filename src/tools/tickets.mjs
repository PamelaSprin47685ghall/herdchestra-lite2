/**
 * Async tickets: the only place `await` is allowed.
 *
 * Each ticket carries one complete async flow and returns a Promise. Stations
 * (SessionStation) stay synchronous; they call these through the injected
 * `tickets` capability bundle or through the js runtime's core-tool table.
 * Tickets call station sync methods for every state transition and never hold
 * shared state of their own.
 *
 * This node is host-free: every host capability arrives as the trailing
 * `host` bag.
 */

import { errorResult } from "./results.mjs";
import { levelKeyOf, ownerIdOf, admitJoin } from "../station/fork-controls.mjs";
import { loadDoc } from "../prompts/index.mjs";
import { notifyWaiters, waitForReady } from "../scope/fork-registry.mjs";
import {
	REQUEST_INTERRUPT_REASON,
	registerRuntime,
} from "../scope/request-queue.mjs";
import { forkRegistryOf } from "../station/ports-contract.mjs";

const errors = loadDoc("errors");

// The agent loop aborts an interruptible tool's signal with this registered
// symbol when a queued user message wants the model. It lives in beat.mjs so
// the state machine and the ticket share one definition.
export { TOOL_INTERRUPT_ABORT_REASON } from "./beat.mjs";

// `scope_request` interrupts a peer for an answer, which is a different
// decision from the user taking the turn back. The interrupt symbol lives with
// the queue that owns it: `REQUEST_INTERRUPT_REASON` in scope/request-queue.mjs.

/**
 * Open one child scope. The station finishes every state transition before
 * this ticket is called, so the parent's receipt is already correct when the
 * host persists it. Child assembly belongs to the host wiring.
 */
export async function forkTicket(station, toolCallId, params, ctx, host = {}, frameId = null) {
	let result;
	try {
		result = station.executeFork(toolCallId, params, ctx, frameId);
	} catch (error) {
		host?.report?.record?.("fork", error, {
			phase: "fork",
			toolCallId,
			stack: error?.stack,
		});
		return errorResult("FORK_INTERNAL_ERROR", String(error?.message ?? error));
	}
	const applyPending = station?.tickets?.applyPendingModelSwitch;
	if (typeof applyPending !== "function") return result;
	return await applyPending(station, ctx, result);
}

/**
 * Receive one returning child. The station takes a ready record in one
 * synchronous beat; when none is ready this ticket parks until one is. The
 * station never waits, so its own state stays atomic.
 */
export async function joinTicket(station, toolCallId, params, ctx, signal = null, host = {}, frameId = null) {
	try {
		const wait = station.forkWaitPort?.() ?? null;
		const first = station.executeJoin(toolCallId, params, ctx, frameId);
		if (first?.details?.code !== "NO_READY_CHILD") {
			// A take closes one bracket. The child parked in scope_return is
			// waiting for exactly that fact, so wake it before answering.
			if (first?.details?.joined && wait) notifyWaiters?.(wait.registry);
			return first;
		}
		if (!wait) return first;
		// Nothing running and nothing ready means no receipt can ever arrive
		// for this owner. Parking here would wait forever for work that does
		// not exist, so the call answers instead of blocking.
		if (first?.details?.active === 0) {
			return errorResult(
				"NO_UNRECEIVED_WORK",
				errors["no-unreceived-work"],
				{ ownerId: ownerIdOf(station) },
			);
		}
		const waited = await (async () => {
			// While parked, a peer sees an idle scope that cannot answer yet: a
			// request must yield this join first. Registering the parking state
			// is what makes that yield reachable; leaving the entry `running`
			// would let an interrupt abort a wait with no beat to stop.
			const selfPath = station.selfScopePath?.() ?? "/";
			const yieldController = new AbortController();
			const relay = () => yieldController.abort(signal?.reason);
			if (signal) {
				if (signal.aborted) relay();
				else signal.addEventListener("abort", relay, { once: true });
			}
			registerRuntime(wait.registry, selfPath, {
				state: "running",
				// One id per join, not one boolean for the whole scope: two joins in
				// one beat must both remain visible until each finishes.
				parked: toolCallId,
				yieldJoin: () => yieldController.abort(REQUEST_INTERRUPT_REASON),
			});
			// The parent's own clock stops while it waits for a child. Hiring
			// people does not spend the manager's personal time budget.
			station.noteRootWait?.(1);
			station.pauseBranchClock?.();
			try {
				return await waitForReady(wait.registry, wait.ledger, {
					ownerId: ownerIdOf(station),
					levelKey: levelKeyOf(station),
					signal: yieldController.signal,
					// Capacity belongs to this model and this record. The record
					// stays ready when it cannot fit, and the ticket answers
					// instead of parking for an event that cannot change it.
					admit: (record) => admitJoin(station, record),
				});
			} finally {
				station.noteRootWait?.(-1);
				station.resumeBranchClock?.();
				signal?.removeEventListener?.("abort", relay);
				// Remove only this join's id and yield hook. A sibling join in the
				// same beat keeps its own entry, so a request can still yield it.
				registerRuntime(wait.registry, selfPath, { parkedRemove: toolCallId });
			}
		})();
		if (!waited.ok) {
			// A queued user message ends the wait like the host's `wait` tool.
			// The join received nothing and no report is owed, so the interrupt
			// answers as a plain refusal.
			return errorResult(waited.code, waited.reason, {
				blocked: waited.blocked ?? [],
			});
		}
		// waitForReady already took the child. Rendering it here keeps the
		// single take: calling executeJoin again would find an empty queue.
		const taken = station.finalizeJoin(toolCallId, waited.fork, ctx, frameId);
		if (taken?.details?.joined) notifyWaiters?.(wait.registry);
		return taken;
	} catch (error) {
		host?.report?.record?.("fork", error, { phase: "join", toolCallId, stack: error?.stack });
		return errorResult("JOIN_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

/**
 * Hand the child's record back. The station seals it and answers in the same
 * beat: the bracket is closed, the record waits in the parent's queue, and
 * this call is done. Nothing parks here, so the child's session stays free to
 * be talked to instead of being stuck inside an open tool call, and the
 * parent's next join takes the record whenever it is ready for it.
 */
/**
 * Close a child that will not return. The station does the whole job in one
 * synchronous beat: the bracket closes as failed, its agent stops, its queued
 * requests settle, and a parked join wakes to take the failure.
 */
export async function abandonTicket(station, toolCallId, params, ctx, _host = {}) {
	try {
		if (typeof station.executeAbandon !== "function") {
			return errorResult("ABANDON_UNAVAILABLE", "This station cannot abandon a scope.");
		}
		return station.executeAbandon(toolCallId, params, ctx);
	} catch (error) {
		return errorResult("ABANDON_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

export async function returnTicket(station, toolCallId, params, ctx, _signal = null, _host = {}, frameId = null) {
	try {
		const result = station.executeReturn(toolCallId, params, ctx, frameId);
		// Every ledger write wakes its waiters: a parent parked in a join is
		// waiting for exactly this record.
		const registry = forkRegistryOf(station);
		if (registry) notifyWaiters(registry);
		return result;
	} catch (error) {
		return errorResult("RETURN_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

/**
 * Request one peer scope's answer and wait for its `scope_reply`.
 *
 * The waiting half is here; the synchronous half — resolving the target,
 * checking the wait graph for a cycle, enqueueing the request, choosing whether
 * to interrupt or to let the next request pick it up — belongs to the station's
 * `handleScopeRequest`. The station returns the pending Promise, so this ticket
 * only owns the clock pause and the error line.
 *
 * Station contract:
 *   station.handleScopeRequest({ toolCallId, params, ctx, signal })
 *     -> Promise<{ content, isError?, details? }>
 *   `details.result` must be `{ ok, from, reply }` on success.
 *
 * A caller that is interrupted mid-wait withdraws an undelivered request; one
 * the target already printed is never withdrawn, because the reply has a
 * reader by then and is simply ignored.
 */
export async function requestTicket(station, toolCallId, params, ctx, signal = null, host = {}) {
	try {
		if (typeof station.handleScopeRequest !== "function") {
			return errorResult("REQUEST_UNAVAILABLE", "This station cannot request another scope.");
		}
		station.noteRootWait?.(1);
		station.pauseBranchClock?.();
		try {
			return await station.handleScopeRequest({ toolCallId, params, ctx, signal });
		} finally {
			station.noteRootWait?.(-1);
			station.resumeBranchClock?.();
		}
	} catch (error) {
		host?.report?.record?.("fork", error, {
			phase: "request",
			toolCallId,
			stack: error?.stack,
		});
		return errorResult("REQUEST_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

/**
 * Answer the request this scope is holding. Only bound while the projection is
 * `AWAITING_REPLY`, so the key does not exist on `api` in any other mode.
 *
 * Station contract:
 *   station.handleScopeReply({ toolCallId, params, ctx })
 *     -> { content, isError?, details? }
 *   `details.result` is `{ ok: true }` on success.
 */
export async function replyTicket(station, toolCallId, params, ctx, _signal = null, host = {}) {
	try {
		if (typeof station.handleScopeReply !== "function") {
			return errorResult("REPLY_UNAVAILABLE", "This station holds no pending request.");
		}
		return station.handleScopeReply({ toolCallId, params, ctx });
	} catch (error) {
		host?.report?.record?.("fork", error, { phase: "reply", toolCallId });
		return errorResult("REPLY_INTERNAL_ERROR", String(error?.message ?? error));
	}
}
