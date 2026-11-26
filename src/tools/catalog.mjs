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
	SEND_DESCRIPTION,
	sendParameters,
} from "./index.mjs";
import {
	forkTicket,
	joinTicket,
	returnTicket,
	sendTicket,
	scopeContextTicket,
} from "./tickets.mjs";

const ESSENTIAL = "essential";

export function createTools({ stationFor, tickets }) {
	return Object.freeze([
		{
			name: "scope_fork",
			label: "Fork Scope",
			description: FORK_DESCRIPTION,
			parameters: forkParameters,
			loadMode: ESSENTIAL,
			// A fork finishes in one synchronous beat and then hands its result
			// to the host's pending model switch. There is no wait to cancel, so
			// it takes no signal: its ticket declares four arguments and a host
			// bag, and that is exactly what it gets.
			execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
				forkTicket(stationFor(ctx), toolCallId, params, ctx, tickets),
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
			name: "scope_send",
			label: "Send To Scope",
			description: SEND_DESCRIPTION,
			parameters: sendParameters,
			loadMode: ESSENTIAL,
			// One synchronous beat: resolve, deliver, wake. There is nothing to
			// wait for and nothing to cancel.
			execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
				sendTicket(stationFor(ctx), toolCallId, params, tickets),
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
