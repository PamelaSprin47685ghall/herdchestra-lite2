/**
 * Herdchestra Lite 2.0 — wiring layer.
 *
 * Pure mechanical assembly per AGENTS.md Ticket Station Method:
 * - instantiate the station registry;
 * - inject host capabilities into ticket factories;
 * - bind external events to station gatekeepers;
 * - register tools whose execute delegates to tickets.
 *
 * No business logic lives here. Every conditional belongs to a station
 * gatekeeper or a ticket.
 */

import {
	installInteractiveCapture,
	installRunnerCapture,
} from "./runner-capture.mjs";
import { createStationRegistry, setActiveRegistry } from "./station.mjs";
import {
	activateToolsTicket,
	contextHandoffTicket,
	deferTicket,
	pinTicket,
	regretTicket,
	scopeTicket,
	sendSteerTicket,
} from "./tickets.mjs";
import { sessionStopTicket } from "./handoff.mjs";
import { todoTicket, TODO_DESCRIPTION, TODO_PARAMETERS } from "./todo.mjs";
import {
	DEFER_DESCRIPTION,
	deferParameters,
	PIN_DESCRIPTION,
	pinParameters,
	REGRET_DESCRIPTION,
	regretParameters,
	SCOPE_DESCRIPTION,
	scopeParameters,
} from "./descriptions.mjs";

/**
 * Capture host-internal classes so runner-capture can patch AgentSession and
 * InteractiveMode prototypes. Prefers the injected host namespace, then falls
 * back to a package import.
 */
export async function installCapture(pi) {
	let injected = null;
	try {
		injected = pi?.pi ?? null;
	} catch {
		// The injected namespace is optional.
	}
	if (typeof injected?.AgentSession === "function") {
		installRunnerCapture(injected.AgentSession);
	}
	installInteractiveCapture(injected?.InteractiveMode);
	try {
		const host = await import("@oh-my-pi/pi-coding-agent");
		if (host?.AgentSession) installRunnerCapture(host.AgentSession);
		installInteractiveCapture(host?.InteractiveMode);
	} catch {
		// Optional. Scope enforcement uses only the public session manager.
	}
}

/** Bind host API capabilities into the ticket bundle injected into stations. */
function buildTickets(pi) {
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

/** Register host events, each bound to its station gatekeeper. */
function wireHooks(pi, registry) {
	let assistantMessageRegistered = false;
	try {
		pi.on("assistant_message", (event, ctx) =>
			registry.stationFor(ctx).onAssistantMessage(event?.message, ctx),
		);
		assistantMessageRegistered = true;
	} catch {
		assistantMessageRegistered = false;
	}
	if (!assistantMessageRegistered) {
		try {
			pi.on("message_end", (event, ctx) =>
				registry.stationFor(ctx).onMessageEnd(event, ctx),
			);
		} catch {
			// Neither assistant_message nor message_end is available.
		}
	}
	pi.on("tool_call", (event, ctx) =>
		registry.stationFor(ctx).onToolCall(event, ctx),
	);
	pi.on("context", (event, ctx) =>
		registry.stationFor(ctx).onContext(event?.messages, ctx),
	);
	pi.on("before_agent_start", (event, ctx) =>
		registry.stationFor(ctx).onBeforeAgentStart(event, ctx),
	);
	pi.on("session_stop", (_event, ctx) =>
		registry.stationForStop(ctx).onSessionStop(ctx),
	);
	pi.on("session_switch", (event, ctx) =>
		registry.stationForStop(ctx).onSessionSwitch(event, ctx),
	);
	pi.on("session_compact", (_event, ctx) =>
		registry.stationFor(ctx).onSessionCompact(ctx),
	);
	pi.on("auto_compaction_end", (event, ctx) =>
		registry.stationForStop(ctx).onAutoCompactionEnd(event, ctx),
	);
}

/** Register control and todo tools; each execute delegates to a ticket. */
function wireTools(pi, registry) {
	pi.registerTool({
		name: "scope",
		label: "Scope",
		description: SCOPE_DESCRIPTION,
		parameters: scopeParameters,
		executionMode: "sequential",
		execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
			scopeTicket(registry.stationFor(ctx), toolCallId, params),
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
		execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
			todoTicket(registry.stationFor(ctx), params, ctx),
	});
}

/** Assemble the extension: registry, hooks, tools. Mechanical only. */
export function wireExtension(pi) {
	const registry = createStationRegistry(pi, buildTickets(pi));
	setActiveRegistry(registry);
	wireHooks(pi, registry);
	wireTools(pi, registry);
}
