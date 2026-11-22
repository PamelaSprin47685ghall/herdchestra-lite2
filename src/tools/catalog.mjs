// The tool catalog: every tool this extension registers, fully bound.
//
// A host registers these in one loop. It never learns which ticket backs which
// tool, and it never builds an `execute` of its own. The flags below are the
// host-facing registration hints; `execute` closes over the station lookup.

import {
	SCOPE_CONTEXT_DESCRIPTION,
	scopeContextParameters,
	FORK_DESCRIPTION,
	forkParameters,
	JOIN_DESCRIPTION,
	joinParameters,
	RETURN_DESCRIPTION,
	returnParameters,
	PANHANDLE_DESCRIPTION,
	panhandleParameters,
	TODO_DESCRIPTION,
	TODO_PARAMETERS,
} from "./index.mjs";
import {
	forkTicket,
	joinTicket,
	returnTicket,
	scopeContextTicket,
	panhandleTicket,
} from "./tickets.mjs";
import { todoTicket } from "./todo.mjs";

const ESSENTIAL = "essential";

export function createTools({ stationFor, tickets }) {
	return Object.freeze([
		{
			name: "scope_fork",
			label: "Fork Scope",
			description: FORK_DESCRIPTION,
			parameters: forkParameters,
			loadMode: ESSENTIAL,
			execute: (toolCallId, params, signal, _onUpdate, ctx) =>
				forkTicket(stationFor(ctx), toolCallId, params, ctx, tickets, signal),
		},
		{
			name: "scope_join",
			label: "Join Child",
			description: JOIN_DESCRIPTION,
			parameters: joinParameters,
			loadMode: ESSENTIAL,
			interruptible: true,
			handlesToolInterrupt: true,
			execute: (toolCallId, params, signal, _onUpdate, ctx) =>
				joinTicket(stationFor(ctx), toolCallId, params, ctx, signal, tickets),
		},
		{
			name: "scope_return",
			label: "Return Scope",
			description: RETURN_DESCRIPTION,
			parameters: returnParameters,
			loadMode: ESSENTIAL,
			execute: (toolCallId, params, signal, _onUpdate, ctx) =>
				returnTicket(stationFor(ctx), toolCallId, params, ctx, signal, tickets),
		},
		{
			name: "scope_context",
			label: "Scope Context",
			description: SCOPE_CONTEXT_DESCRIPTION,
			parameters: scopeContextParameters,
			loadMode: ESSENTIAL,
			execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
				scopeContextTicket(stationFor(ctx), toolCallId, params, tickets),
		},
		{
			name: "scope_panhandle",
			label: "Panhandle for Budget",
			description: PANHANDLE_DESCRIPTION,
			parameters: panhandleParameters,
			loadMode: ESSENTIAL,
			execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
				panhandleTicket(stationFor(ctx), toolCallId, params, tickets),
		},
		{
			name: "todo",
			label: "Todo",
			description: TODO_DESCRIPTION,
			parameters: TODO_PARAMETERS,
			strict: true,
			lenientArgValidation: true,
			loadMode: ESSENTIAL,
			approval: "read",
			execute: (_toolCallId, params, _signal, _onUpdate, ctx) =>
				todoTicket(stationFor(ctx), params, ctx),
		},
	]);
}

/**
 * Bind a catalog to a host's `registerTool`. The composition root calls this
 * once; a test that owns a fake registry can call it too.
 */
export function wireTools(pi, target, tickets = {}) {
	const stationFor =
		typeof target === "function" ? target : (ctx) => target.stationFor(ctx);
	for (const tool of createTools({ stationFor, tickets })) pi.registerTool(tool);
}
