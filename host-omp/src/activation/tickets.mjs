// Activation ticket bundle: bind host API capabilities for station injection.

import {
	applyPendingModelSwitch,
	rewindRootTicket,
	restoreScopedModelTicket,
	sendSteerTicket,
	sendUserMessageTicket,
} from "../host/host-tickets.mjs";
import { record } from "../host/diagnostics.mjs";

/**
 * Detach a fire-and-forget ticket at the dispatch boundary. The tickets also
 * catch internally; this keeps a future ticket that forgets from becoming an
 * unhandled rejection.
 */
function detach(start) {
	try {
		const result = start();
		if (result && typeof result.catch === "function") {
			result.catch((error) => record("tickets", error));
		}
		return result;
	} catch (error) {
		record("tickets", error);
		return undefined;
	}
}

export function buildTickets(pi) {
	return Object.freeze({
		steer: (text) => detach(() => sendSteerTicket(pi, text)),
		canSteer: typeof pi?.sendUserMessage === "function",
		prompt: (text) => detach(() => sendUserMessageTicket(pi, text)),
		canPrompt: typeof pi?.sendUserMessage === "function",
		restoreScopedModel: restoreScopedModelTicket,
		rewindRoot: (station, ctx, plan) => rewindRootTicket(pi, station, ctx, plan),
		applyPendingModelSwitch: (station, ctx, result) =>
			applyPendingModelSwitch(pi, station, ctx, result),
	});
}
