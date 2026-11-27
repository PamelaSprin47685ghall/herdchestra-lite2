/**
 * Async tickets: the only place `await` is allowed.
 *
 * Each ticket carries one complete async flow and returns a Promise. Stations
 * (SessionStation) stay synchronous; they call these through the injected
 * `tickets` capability bundle or through the js runtime's core-tool table.
 * Tickets call station sync methods for every state transition and never hold
 * shared state of their own.
 */

import { errorResult } from "./results.mjs";
import { admitJoin, levelKeyOf, ownerIdOf } from "../station/fork-reads.mjs";
import { loadDoc } from "../prompts/index.mjs";
import { notifyWaiters } from "../scope/fork-registry.mjs";
import { waitForReady } from "./join-wait.mjs";
import { forkRegistryOf } from "../station/ports-contract.mjs";

const errors = loadDoc("errors");

export { TOOL_INTERRUPT_ABORT_REASON } from "./beat.mjs";

/**
 * Open one or more subscopes. The station finishes every state transition before
 * this ticket is called, so the caller's receipt is already correct when the
 * host persists it.
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
 * Receive one returning subscope (FIFO). The station takes a ready record in one
 * synchronous beat; when none is ready this ticket parks until one is.
 */
export async function joinTicket(station, toolCallId, params, ctx, signal = null, host = {}, frameId = null) {
	try {
		const wait = station.forkWaitPort?.() ?? null;
		const first = station.executeJoin(toolCallId, params, ctx, frameId);
		if (first?.details?.code !== "NO_READY_CHILD") {
			if (first?.details?.joined && wait) notifyWaiters?.(wait.registry);
			return first;
		}
		if (!wait) return first;
		if (first?.details?.active === 0) {
			return errorResult(
				"NO_UNRECEIVED_WORK",
				errors["no-unreceived-work"],
				{ ownerId: ownerIdOf(station) },
			);
		}
		const waited = await (async () => {
			station.noteRootWait?.(1);
			station.pauseBranchClock?.();
			try {
				return await waitForReady(wait.registry, wait.ledger, {
					ownerId: ownerIdOf(station),
					levelKey: levelKeyOf(station),
					signal,
					admit: (record) => admitJoin(station, record),
				});
			} finally {
				station.noteRootWait?.(-1);
				station.resumeBranchClock?.();
			}
		})();
		if (!waited.ok) {
			return errorResult(waited.code, waited.reason, {
				blocked: waited.blocked ?? [],
			});
		}
		const taken = station.finalizeJoin(toolCallId, waited.fork, ctx, frameId);
		if (taken?.details?.joined) notifyWaiters?.(wait.registry);
		return taken;
	} catch (error) {
		host?.report?.record?.("fork", error, { phase: "join", toolCallId, stack: error?.stack });
		return errorResult("JOIN_INTERNAL_ERROR", String(error?.message ?? error));
	}
}

/**
 * Interrupt any running scope at exact path `target` and force its next turn
 * into `ABANDONED` mode (only `scope_return` bound).
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
		const registry = forkRegistryOf(station);
		if (registry) notifyWaiters(registry);
		return result;
	} catch (error) {
		return errorResult("RETURN_INTERNAL_ERROR", String(error?.message ?? error));
	}
}
