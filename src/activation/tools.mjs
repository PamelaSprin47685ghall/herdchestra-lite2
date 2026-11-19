// Activation tools: register control and todo tools; each execute delegates
// to a ticket.

import {
	DEFER_DESCRIPTION,
	deferParameters,
	PIN_DESCRIPTION,
	pinParameters,
	REGRET_DESCRIPTION,
	regretParameters,
	SCOPE_DESCRIPTION,
	scopeParameters,
} from "../tools/descriptions.mjs";
import {
	deferTicket,
	pinTicket,
	regretTicket,
	scopeTicket,
} from "../tools/tickets.mjs";
import {
	TODO_DESCRIPTION,
	TODO_PARAMETERS,
	todoTicket,
} from "../tools/index.mjs";

export function wireTools(pi, registry) {
	pi.registerTool({
		name: "scope",
		label: "Scope",
		description: SCOPE_DESCRIPTION,
		parameters: scopeParameters,
		executionMode: "sequential",
		concurrency: "exclusive",
		execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
			scopeTicket(registry.stationFor(ctx), toolCallId, params, ctx),
	});
	pi.registerTool({
		name: "regret",
		label: "Regret",
		description: REGRET_DESCRIPTION,
		parameters: regretParameters,
		executionMode: "sequential",
		execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
			regretTicket(registry.stationFor(ctx), toolCallId, params),
	});
	pi.registerTool({
		name: "defer",
		label: "Defer",
		description: DEFER_DESCRIPTION,
		parameters: deferParameters,
		executionMode: "sequential",
		execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
			deferTicket(registry.stationFor(ctx), toolCallId, params),
	});
	pi.registerTool({
		name: "pin",
		label: "Pin",
		description: PIN_DESCRIPTION,
		parameters: pinParameters,
		executionMode: "sequential",
		execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
			pinTicket(registry.stationFor(ctx), toolCallId, params),
	});
	// The extension writes this name after the host registered its own todo,
	// so the host map keeps this override. `execute` delegates to the native
	// tool through ctx.invokeTool and never keeps a second ledger.
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: TODO_DESCRIPTION,
		parameters: TODO_PARAMETERS,
		executionMode: "sequential",
		concurrency: "exclusive",
		strict: true,
		lenientArgValidation: true,
		loadMode: "essential",
		approval: "read",
		execute: (_toolCallId, params, _signal, _onUpdate, ctx) =>
			todoTicket(registry.stationFor(ctx), params, ctx),
	});
}
