// Activation ticket bundle: bind host API capabilities for station injection.

import {
	activateToolsTicket,
	restoreScopedModelTicket,
	sendSteerTicket,
	sendUserMessageTicket,
} from "../tools/tickets.mjs";

export function buildTickets(pi) {
	return {
		steer: (text) => {
			void sendSteerTicket(pi, text);
		},
		canSteer: typeof pi?.sendUserMessage === "function",
		prompt: (text) => {
			void sendUserMessageTicket(pi, text);
		},
		canPrompt: typeof pi?.sendUserMessage === "function",
		restoreScopedModel: restoreScopedModelTicket,
		activateTools: (activeTools, prompt, changed) =>
			activateToolsTicket(pi, activeTools, prompt, changed),
	};
}
