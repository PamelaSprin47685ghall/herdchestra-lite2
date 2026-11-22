// Activation tools: register control and todo tools; each execute delegates
// to a ticket.

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
} from "herdchestra-lite2";
import {
	forkTicket,
	panhandleTicket,
	joinTicket,
	scopeContextTicket,
	returnTicket,
} from "../host/host-tickets.mjs";
import {
	TODO_DESCRIPTION,
	TODO_PARAMETERS,
	todoTicket,
} from "herdchestra-lite2";

export function wireTools(pi, registry) {
	// The fork/join face: one left bracket and the two right brackets that close
	// it. Every call mutates one session-wide ledger, so a parent and its
	// children agree on which bracket is still open.
	pi.registerTool({
		name: "scope_fork",
		label: "Fork Scope",
		description: FORK_DESCRIPTION,
		parameters: forkParameters,
		// Every tool here is part of the working protocol, so its schema must
		// stay in the top-level request instead of moving behind xd://.
		loadMode: "essential",
		execute: (toolCallId, params, signal, _onUpdate, ctx) =>
			forkTicket(registry.stationFor(ctx), toolCallId, params, ctx, signal),
	});
	pi.registerTool({
		name: "scope_join",
		label: "Join Child",
		description: JOIN_DESCRIPTION,
		parameters: joinParameters,
		loadMode: "essential",
		// The join is a pure wait: a queued user message ends it cleanly, and
		// an interrupt already queued when the call starts must not be skipped
		// (the settlement still has to run).
		interruptible: true,
		handlesToolInterrupt: true,
		execute: (toolCallId, params, signal, _onUpdate, ctx) =>
			joinTicket(registry.stationFor(ctx), toolCallId, params, ctx, signal),
	});
	pi.registerTool({
		name: "scope_return",
		label: "Return Scope",
		description: RETURN_DESCRIPTION,
		parameters: returnParameters,
		loadMode: "essential",
		execute: (toolCallId, params, signal, _onUpdate, ctx) =>
			returnTicket(registry.stationFor(ctx), toolCallId, params, ctx, signal),
	});
	pi.registerTool({
		name: "scope_context",
		label: "Scope Context",
		description: SCOPE_CONTEXT_DESCRIPTION,
		parameters: scopeContextParameters,
		loadMode: "essential",
		execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
			scopeContextTicket(registry.stationFor(ctx), toolCallId, params),
	});
	pi.registerTool({
		name: "scope_panhandle",
		label: "Panhandle for Budget",
		description: PANHANDLE_DESCRIPTION,
		parameters: panhandleParameters,
		loadMode: "essential",
		// The grant is synchronous and must survive a dead clock: this is the
		// call that buys the next second. It is free by station decision, so a
		// branch with an empty account can still ask.
		execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
			panhandleTicket(registry.stationFor(ctx), toolCallId, params),
	});
	// The extension writes this name after the host registered its own todo,
	// so the host map keeps this override. `execute` delegates to the native
	// tool through ctx.invokeTool and never keeps a second ledger.
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: TODO_DESCRIPTION,
		parameters: TODO_PARAMETERS,
		strict: true,
		lenientArgValidation: true,
		loadMode: "essential",
		approval: "read",
		execute: (_toolCallId, params, _signal, _onUpdate, ctx) =>
			todoTicket(registry.stationFor(ctx), params, ctx),
	});
}
