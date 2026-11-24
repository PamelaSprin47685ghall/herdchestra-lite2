/**
 * Async tickets: the only place `await` is allowed.
 *
 * Each ticket carries one complete async flow and returns a Promise. Stations
 * (SessionStation) stay synchronous; they call these through the injected
 * `tickets` capability bundle at wiring time. Tickets call station sync
 * methods for every state transition and never hold shared state of their own.
 *
 * This node is host-free: every host capability arrives as the trailing
 * `host` bag. The host adapter (`src/host/host-tickets.mjs`) binds the bag and
 * is the entry the wiring imports.
 */

import { errorResult, textResult } from "./results.mjs";
import { PIN_INTERNAL_ERROR } from "../features/pin/index.mjs";
import { levelKeyOf, ownerIdOf, admitJoin } from "../station/fork-controls.mjs";
import { loadDoc } from "../prompts/index.mjs";
import { notifyWaiters, waitForReady } from "../scope/fork-registry.mjs";

const errors = loadDoc("errors");

// The agent loop aborts an interruptible tool's signal with this registered
// symbol when a queued user message wants the model. `Symbol.for` resolves to
// the host's symbol without importing its package.
export const TOOL_INTERRUPT_ABORT_REASON = Symbol.for("pi-agent-core.tool-interrupt");

function isUserInputInterrupt(signal) {
	return signal?.aborted === true && signal.reason === TOOL_INTERRUPT_ABORT_REASON;
}

/**
 * Open one child scope. The station finishes every state transition before
 * this ticket is called, so the parent's receipt is already correct when the
 * host persists it. Child assembly belongs to the host wiring.
 */
export async function forkTicket(station, toolCallId, params, ctx, host = {}) {
	let result;
	try {
		result = station.executeFork(toolCallId, params, ctx);
	} catch (error) {
		// The host bag is the fifth argument, and this is what it is for: a
		// fork that dies inside the station leaves a diagnostic, exactly as a
		// join does. A caller that slips a signal into this position loses the
		// record instead of the promise.
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
export async function joinTicket(station, toolCallId, params, ctx, signal = null, host = {}) {
	try {
		const wait = station.forkWaitPort?.() ?? null;
		const first = station.executeJoin(toolCallId, params, ctx);
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
			// The parent's own clock stops while it waits for a child. Hiring
			// people does not spend the manager's personal time budget.
			station.noteRootWait?.(1);
			station.pauseBranchClock?.();
			try {
				return await waitForReady(wait.registry, wait.ledger, {
					ownerId: ownerIdOf(station),
					levelKey: levelKeyOf(station),
					signal,
					// Capacity belongs to this model and this record. The record
					// stays ready when it cannot fit, and the ticket answers
					// instead of parking for an event that cannot change it.
					admit: (record) => admitJoin(station, record),
				});
			} finally {
				station.noteRootWait?.(-1);
				station.resumeBranchClock?.();
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
		const taken = station.finalizeJoin(toolCallId, waited.fork, ctx);
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
export async function returnTicket(station, toolCallId, params, ctx, _signal = null, _host = {}) {
	try {
		const result = station.executeReturn(toolCallId, params, ctx);
		// Every ledger write wakes its waiters: a parent parked in a join is
		// waiting for exactly this record.
		const wait = station.forkWaitPort?.() ?? null;
		if (wait?.registry) notifyWaiters(wait.registry);
		return result;
	} catch (error) {
		return errorResult("RETURN_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

/** One message addressed by path; every state change is synchronous. */
export async function sendTicket(station, toolCallId, params, host = {}) {
	try {
		return station.executeSend(toolCallId, params);
	} catch (error) {
		host?.report?.record?.("fork", error, { phase: "send", toolCallId });
		return errorResult("SEND_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

/**
 * One call that may carry a note, an amend, or both. The amend half runs
 * first so its refund is already in the ledger when the note is saved. The
 * two halves use derived cache keys: the host retries the outer call id, and
 * the direct-amend path may already have answered that id before this ticket.
 */
export async function scopeContextTicket(station, toolCallId, params, host = {}) {
	let args = params;
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			args = null;
		}
	}
	if (args?.pin === undefined && args?.amend === undefined) {
		return errorResult("scope_context-empty", errors["scope-context-empty"]);
	}
	try {
		return station.executeContext(toolCallId, args);
	} catch (error) {
		host?.report?.record?.("tickets", error, { kind: "scope_context", toolCallId });
		return errorResult(PIN_INTERNAL_ERROR, errors["pin-internal-error"]);
	}
}

