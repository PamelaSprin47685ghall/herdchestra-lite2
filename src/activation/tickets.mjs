// Activation ticket bundle: bind host API capabilities for station injection.

import {
	activateToolsTicket,
	sendSteerTicket,
	switchModelTicket,
} from "../tools/tickets.mjs";
import { sessionStopTicket } from "../handoff/index.mjs";

async function restoreScopedModel(station, ctx, req, result, finish) {
	const outcome = await switchModelTicket(station.pi, ctx, req);
	station.reconcileActualModel(ctx, req, outcome);
	if (!outcome.ok) station.lastError = `${req.command}: ${outcome.reason}`;
	return finish ? finish(result) : result;
}

export function buildTickets(pi) {
	return {
		steer: (text) => {
			void sendSteerTicket(pi, text);
		},
		canSteer: typeof pi?.sendUserMessage === "function",
		restoreScopedModel,
		sessionStop: sessionStopTicket,
		activateTools: (activeTools, prompt, changed) =>
			activateToolsTicket(pi, activeTools, prompt, changed),
	};
}
