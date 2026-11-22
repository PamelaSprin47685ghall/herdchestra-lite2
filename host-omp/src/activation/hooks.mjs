// Activation hooks: bind each host event to its station gatekeeper.

import { sessionFor } from "../host/capture.mjs";
import { record } from "../host/diagnostics.mjs";
import { installContextPreparation } from "../host/context-preparation.mjs";
import { wireProviderObservation } from "../host/provider-observer.mjs";
import { installToolDispatch } from "../host/tool-dispatch.mjs";


/**
 * The capture map is keyed by the session manager. A forked child has its own
 * manager proxy, so the identity must agree before the seam is installed. An
 * unknown id keeps the existing session path.
 */
function dispatchSession(ctx) {
	const session = sessionFor(ctx);
	if (!session) return null;
	let actual = null;
	try {
		actual = session.getAgentId?.();
	} catch {
		actual = null;
	}
	const expected = typeof ctx?.agent?.id === "string" && ctx.agent.id !== "" ? ctx.agent.id : null;
	if (expected && typeof actual === "string" && actual !== "" && actual !== expected) return null;
	return session;
}

/**
 * Bind every host event to its gatekeeper and report the one failure a host
 * cannot recover from on its own: no message event at all.
 *
 * `assistant_message` drives scope transitions; `message_end` is the
 * fallback. When both registrations throw, every scope, pin, and relay
 * decision stops arriving, yet the extension still loads and the status line
 * looks healthy. That silence is the bug this return value closes.
 */
export function wireHooks(pi, engine, sharedFirstTurn = null) {
	// A wiring may hand a full engine or a station-shaped double.
	const stationOf = (ctx) => (engine.station ?? engine.stationFor)(ctx);
	const stationForStop = (ctx) => (engine.stationForStop ?? engine.stationFor)(ctx);
	const bindDispatch = (ctx) => {
		const station = stationOf(ctx);
		const session = dispatchSession(ctx);
		installToolDispatch(
			session,
			(message, id, name) => station.prepareToolDispatch(message, id, name),
			(id, name, toolCtx, receipt) =>
				station.admitToolDispatch(id, name, toolCtx, receipt),
		);
		if (session) installContextPreparation(session, { station, ctx });
		return station;
	};
	wireProviderObservation(pi, engine);
	pi.on("before_provider_request", (_event, ctx) => {
		const station = stationOf(ctx);
		station.noteScopeRequest?.();
		station.beginRequestSample?.(Date.now());
	});
	pi.on("session_start", (_event, ctx) => {
		bindDispatch(ctx);
	});
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
				stationOf(ctx).onMessageEnd(event, ctx),
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
			pi.on("message_end", (event, ctx) => {
				const message = event?.message;
				if (message?.role !== "assistant") return;
				stationOf(ctx).onUsageMessage(message, ctx);
			});
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
		stationOf(ctx).onToolCall(event, ctx),
	);
	pi.on(
		"context",
		(event, ctx) =>
			bindDispatch(ctx).onContext(event?.messages, ctx, sharedFirstTurn),
	);
	pi.on("before_agent_start", (event, ctx) =>
		bindDispatch(ctx).onBeforeAgentStart(event, ctx),
	);
	pi.on("session_stop", (event, ctx) =>
		stationForStop(ctx).onSessionStop(ctx, {
			signal: event?.signal ?? null,
			reason: event?.last_assistant_message?.stopReason ?? null,
		}),
	);
	pi.on("session_switch", (event, ctx) => {
		const result = stationForStop(ctx).onSessionSwitch(event, ctx);
		bindDispatch(ctx);
		return result;
	});
	pi.on("session_compact", (_event, ctx) =>
		stationOf(ctx).onSessionCompact(ctx),
	);
	return {
		ok: transitionsBound,
		missing: transitionsBound ? [] : ["assistant_message", "message_end"],
		error: transitionsBound
			? null
			: "neither assistant_message nor message_end could be registered",
	};
}
