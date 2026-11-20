// Activation hooks: bind each host event to its station gatekeeper.

import { sessionFor } from "../host/capture.mjs";
import { record } from "../host/diagnostics.mjs";
import { hackContext } from "../host/hack-context.mjs";
import { installScopeDispatch } from "../host/scope-dispatch.mjs";

/**
 * Bind every host event to its gatekeeper and report the one failure a host
 * cannot recover from on its own: no message event at all.
 *
 * `assistant_message` drives scope transitions; `message_end` is the
 * fallback. When both registrations throw, every scope, pin, and relay
 * decision stops arriving, yet the extension still loads and the status line
 * looks healthy. That silence is the bug this return value closes.
 */
export function wireHooks(pi, registry) {
	const bindDispatch = (ctx) => {
		const station = registry.stationFor(ctx);
		installScopeDispatch(
			sessionFor(ctx),
			(message, id, name) => station.prepareScopeDispatch(message, id, name),
			(id, name, toolCtx, receipt) =>
				station.admitScopeDispatch(id, name, toolCtx, receipt),
		);
		return station;
	};
	let transitionsBound = false;
	try {
		pi.on("assistant_message", (event, ctx) =>
			bindDispatch(ctx).onAssistantMessage(event?.message, ctx),
		);
		transitionsBound = true;
	} catch {
		transitionsBound = false;
	}
	if (!transitionsBound) {
		try {
			pi.on("message_end", (event, ctx) =>
				registry.stationFor(ctx).onMessageEnd(event, ctx),
			);
			transitionsBound = true;
		} catch {
			transitionsBound = false;
		}
	} else {
		// Some providers attach usage only at message_end. Record it with a
		// dedicated, safe listener even when assistant_message already drives
		// the scope transitions.
		try {
			pi.on("message_end", (event, ctx) =>
				registry.stationFor(ctx).onUsageMessage(event?.message, ctx),
			);
		} catch (error) {
			// Usage at message_end is optional only for providers that attach
			// usage earlier. When this binding is refused, that late usage is
			// simply gone, so the refusal is recorded rather than commented away.
			record("hooks", error, {
				missing: ["message_end"],
				optional: true,
			});
		}
	}
	if (!transitionsBound) {
		record(
			"hooks",
			new Error(
				"neither assistant_message nor message_end could be registered",
			),
			{ missing: ["assistant_message", "message_end"] },
		);
	}
	pi.on("tool_call", (event, ctx) =>
		registry.stationFor(ctx).onToolCall(event, ctx),
	);
	hackContext(pi, (event, ctx) =>
		bindDispatch(ctx).onContext(event?.messages, ctx),
	);
	pi.on("before_agent_start", (event, ctx) => {
		const station = registry.stationFor(ctx);
		return station.onBeforeAgentStart(event, ctx);
	});
	pi.on("session_stop", (_event, ctx) =>
		registry.stationForStop(ctx).onSessionStop(ctx),
	);
	pi.on("session_switch", (event, ctx) =>
		registry.stationForStop(ctx).onSessionSwitch(event, ctx),
	);
	pi.on("session_compact", (_event, ctx) =>
		registry.stationFor(ctx).onSessionCompact(ctx),
	);
	return {
		ok: transitionsBound,
		missing: transitionsBound ? [] : ["assistant_message", "message_end"],
		error: transitionsBound
			? null
			: "neither assistant_message nor message_end could be registered",
	};
}
