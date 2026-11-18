// Activation ticket bundle: bind host API capabilities for station injection.

import {
	activateToolsTicket,
	contextHandoffTicket,
	sendSteerTicket,
} from "../tools/tickets.mjs";
import { sessionStopTicket } from "../handoff/index.mjs";

export function buildTickets(pi) {
	return {
		steer: (text) => {
			void sendSteerTicket(pi, text);
		},
		canSteer: typeof pi?.sendUserMessage === "function",
		contextHandoff: contextHandoffTicket,
		sessionStop: (station, ctx) => sessionStopTicket(station, ctx, pi),
		activateTools: (activeTools, prompt, changed) =>
			activateToolsTicket(pi, activeTools, prompt, changed),
	};
}
