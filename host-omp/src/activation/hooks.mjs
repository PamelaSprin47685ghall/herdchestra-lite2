// Activation hooks: bind each host event to its station gatekeeper.

import {
	releaseScopeReturnDrain,
	releaseScopeReturnRunHold,
	stopAfterScopeReturn,
} from "../host/branch-context.mjs";
import { sessionFor } from "../host/capture.mjs";
import { confiscateContext } from "../host/tool-confiscation.mjs";
import {
activatePrintGoalFromPrompt,
handleGoalInput,
needsGoalPreload,
observeOfficialGoalForStop,
preloadOfficialGoalTool,
shouldActivatePrintGoal,
} from "../host/tickets/goal.mjs";
import { record } from "../host/diagnostics.mjs";
import { installContextPreparation } from "../host/context-preparation.mjs";
import { wireProviderObservation } from "../host/provider-observer.mjs";


import { USER_ABORT_CAPTURE } from "../host/process-symbols.mjs";

/**
 * Wrap one context's abort method once. The host invokes the same function for
 * native Esc and for programmatic cancellation; the scope domain needs the
 * user's intent before the host's terminal events become ambiguous.
 */
function captureContextAbort(ctx, userAbort) {
	if (!ctx || typeof ctx !== "object") return;
	if (typeof ctx.abort !== "function") return;
	if (ctx[USER_ABORT_CAPTURE]) return;
	const original = ctx.abort;
	const wrapped = function (...args) {
		userAbort(ctx);
		return original.apply(this, args);
	};
	Object.defineProperty(ctx, USER_ABORT_CAPTURE, {
		value: wrapped,
		enumerable: false,
		configurable: true,
	});
	ctx.abort = wrapped;
}

function installUserAbortCapture(pi, userAbort) {
	for (const event of ["session_start", "before_agent_start", "context"]) {
		try {
			pi.on(event, (_payload, ctx) => {
				captureContextAbort(ctx, userAbort);
				return undefined;
			});
		} catch {
			// A host that refuses one event still captures the others.
		}
	}
}

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
export function wireHooks(pi, engine) {
  	// `engine.station` is the one entry the core exposes. A second spelling for a
  	// station-shaped double only made every call site guess which one answered.
  	const stationOf = (ctx) => engine.station(ctx);
	// Official mode observation never mints a station: a goal event for a context
	// nobody owns must not race the root station hook.
	const observedStation = (ctx) => {
		try {
			return typeof engine.peekStation === "function" ? engine.peekStation(ctx) : null;
		} catch {
			return null;
		}
	};
	/** A mode snapshot may spell the goal as a status string or a record. */
	const goalStatusOf = (mode) => {
		const goal = mode?.goal ?? null;
		if (typeof goal === "string") return goal;
		if (goal && typeof goal.status === "string") return goal.status;
		return null;
	};
	const syncOfficialGoal = (ctx, station) => {
		try {
			const mode = ctx?.sessionModes?.getState?.() ?? null;
			const runtime = (() => {
				try {
					return sessionFor(ctx)?.goalRuntime ?? null;
				} catch {
					return null;
				}
			})();
			const runtimeState = runtime?.getState?.() ?? null;
			const status = goalStatusOf(mode) ?? goalStatusOf(runtimeState?.goal ?? null);
			if (!status) return;
			station.syncOfficialGoalState?.(
				status,
				status === "active",
				runtimeState?.goal?.id ?? null,
			);
		} catch (error) {
			record("hooks", error, { phase: "goal-sync" });
		}
	};
	// Native Esc is consumed by the host before any terminal event is emitted.
	// Capture the user's own ctx.abort at the entry point and turn it into the
	// same typed USER_ABORT gate the web stop button uses. USER_ABORT must never
	// be reconstructed later from assistant stopReason or missing session_stop.
	const userAbortOf = (ctx) => {
		const typed = engine.userAbort;
		try {
			if (typeof typed === "function") typed(ctx, { kind: "USER_ABORT", source: "host" });
		} catch (error) {
			record("hooks", error, { phase: "user-abort" });
		} finally {
			const session = dispatchSession(ctx);
			releaseScopeReturnDrain(session);
			releaseScopeReturnRunHold(session);
		}
	};
	installUserAbortCapture(pi, userAbortOf);
  	// A session is prepared once, when it starts or switches. Every other event
  	// reads the station it already has: re-running the install on each assistant
  	// message re-entered the host's preparation seam every turn and hid a failed
  	// first binding behind a silent retry. A session seen before `session_start`
  	// is still prepared on first sight, so a host that fires out of order is
  	// served rather than refused.
  	const boundSessions = new WeakSet();
  	const bindSession = (ctx) => {
  		const station = stationOf(ctx);
  		const session = dispatchSession(ctx);
  		if (session) {
  			stopAfterScopeReturn(session.agent, session);
  			installContextPreparation(session, { station, ctx });
  			boundSessions.add(session);
  		}
  		return station;
  	};
  	const ensureBound = (ctx) => {
  		const session = dispatchSession(ctx);
  		if (session && !boundSessions.has(session)) return bindSession(ctx);
  		return stationOf(ctx);
  	};
	wireProviderObservation(pi, engine);
	// `/herd-goal` is the alias path. In a TUI `/goal` keeps its built-in
	// command, so the official grammar stays the only one there is.
	try {
		pi.on("input", (event, ctx) => handleGoalInput(event, ctx, stationOf(ctx), pi));
	} catch (error) {
		record("hooks", error, { missing: ["input"], optional: true });
	}
	pi.on("before_provider_request", (_event, ctx) => {
		const station = stationOf(ctx);
		station.noteScopeRequest?.();
		station.beginRequestSample?.(Date.now());
	});
	pi.on("session_start", (_event, ctx) => {
		const station = bindSession(ctx);
		if (!needsGoalPreload(ctx)) {
			syncOfficialGoal(ctx, station);
			return undefined;
		}
		// Add `goal` to the live roster before the first request, then hide it
		// again at once: the model sees `api.goal`, never a second top-level tool.
		return (async () => {
			const changed = await preloadOfficialGoalTool(ctx);
			if (changed) confiscateContext(() => engine, ctx);
			syncOfficialGoal(ctx, station);
		})();
	});
	let transitionsBound = false;
	try {
  		pi.on("assistant_message", (event, ctx) =>
  			ensureBound(ctx).onAssistantMessage(event?.message, ctx),
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
  	pi.on(
  		"context",
  		(event, ctx) => ensureBound(ctx).onContext(event?.messages, ctx),
  	);
	pi.on("before_agent_start", (event, ctx) => {
		const session = dispatchSession(ctx);
		releaseScopeReturnDrain(session);
		releaseScopeReturnRunHold(session);
  		const station = ensureBound(ctx);
		// Print mode has no `input` hook: the first prompt may itself carry
		// `/goal set ...`, and the normal path must stay synchronous.
		const printGoal = shouldActivatePrintGoal(event, ctx, station);
		if (!printGoal) {
			syncOfficialGoal(ctx, station);
			return station.onBeforeAgentStart(event, ctx);
		}
		return (async () => {
			await activatePrintGoalFromPrompt(printGoal, ctx, station);
			syncOfficialGoal(ctx, station);
			return station.onBeforeAgentStart(event, ctx);
		})();
	});
	pi.on("agent_end", (event, ctx) => {
		// Only the typed abort entry proves USER_ABORT. This frame says what
		// ended and whether the host is already continuing it.
		try {
			stationOf(ctx).onAgentEnd(ctx, {
				messages: event?.messages,
				willContinue: event?.willContinue,
				...(event?.awaitingAsyncWork === true ? { awaitingAsyncWork: true } : {}),
			});
		} finally {
			// A rewind ticket claims its own queue hold and run-active hold
			// synchronously. A pause or a stale/cancelled plan must not leave
			// either original hold armed.
			const session = dispatchSession(ctx);
			releaseScopeReturnDrain(session);
			releaseScopeReturnRunHold(session);
		}
	});
	pi.on("session_stop", (event, ctx) =>
		stationOf(ctx).onSessionStop(ctx, {
			signal: event?.signal ?? null,
			reason: event?.last_assistant_message?.stopReason ?? null,
			messages: event?.messages ?? null,
			...observeOfficialGoalForStop(ctx),
		}),
	);
	// The official goal may complete on its own (its goal tool) or be dropped by
	// the user. The station learns it here; it never polls a mode it does not own.
	try {
		pi.on("goal_updated", (event, ctx) => {
			const station = observedStation(ctx);
			station?.onOfficialGoalUpdated?.(event?.goal ?? null, event?.state ?? null);
		});
	} catch (error) {
		record("hooks", error, { missing: ["goal_updated"], optional: true });
	}
	try {
		pi.on("mode_changed", (event, ctx) => {
			const station = observedStation(ctx);
			station?.onOfficialModeChanged?.(
				goalStatusOf(event?.previous),
				goalStatusOf(event?.state),
			);
		});
	} catch (error) {
		record("hooks", error, { missing: ["mode_changed"], optional: true });
	}
	pi.on("session_switch", (event, ctx) => {
		const session = dispatchSession(ctx);
		releaseScopeReturnDrain(session);
		releaseScopeReturnRunHold(session);
  		const result = stationOf(ctx).onSessionSwitch(event, ctx);
  		// A switch replaces the session's preparation binding.
  		if (session) boundSessions.delete(session);
  		bindSession(ctx);
  		return result;
	});
	pi.on("session_compact", (_event, ctx) => {
		const session = dispatchSession(ctx);
		releaseScopeReturnDrain(session);
		releaseScopeReturnRunHold(session);
		return stationOf(ctx).onSessionCompact(ctx);
	});
	return {
		ok: transitionsBound,
		missing: transitionsBound ? [] : ["assistant_message", "message_end"],
		error: transitionsBound
			? null
			: "neither assistant_message nor message_end could be registered",
	};
}
