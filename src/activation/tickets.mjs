// Activation ticket bundle: bind host API capabilities for station injection.

import {
	activateToolsTicket,
	restoreScopedModelTicket,
	sendSteerTicket,
	sendUserMessageTicket,
} from "../tools/tickets.mjs";
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
	return {
		steer: (text) => detach(() => sendSteerTicket(pi, text)),
		canSteer: typeof pi?.sendUserMessage === "function",
		prompt: (text) => detach(() => sendUserMessageTicket(pi, text)),
		canPrompt: typeof pi?.sendUserMessage === "function",
		restoreScopedModel: restoreScopedModelTicket,
		activateTools: (activeTools, prompt, changed) =>
			activateToolsTicket(pi, activeTools, prompt, changed),
	};
}
