// Activation hooks: bind each host event to its station gatekeeper.

import { sessionFor } from "../host/capture.mjs";
import { record } from "../host/diagnostics.mjs";
import { hackContext } from "../host/hack-context.mjs";
import { installScopeDispatch } from "../host/scope-dispatch.mjs";
import { continueFeedback } from "../tools/results.mjs";

/**
 * Mark the owner's registered batch as retiring and end its run. The host
 * emits `tool_result` inside the tool's own execute (wrapper.ts:541), before
 * agent-loop emits and commits the result message. The abort is still safe:
 * the loop commits a completed tool's real result even when the signal
 * aborted (agent-loop.ts `completedToolExecution` path); only the next model
 * call is cancelled. The scheduler starts the flows at `agent_end`, after it
 * awaits the owner session's `settleInFlightMessagePersistence()`.
 */
function retirePendingBatch(station, registry, ctx, toolCallId) {
	const batch = station?.pendingFission;
	// A flow-owned station may itself have opened an inner batch, so the
	// pending descriptor, not the flow flag, decides who retires.
	if (!batch || batch.retired === true) return false;
	if (batch.toolCallId !== toolCallId) return false;
	batch.retired = true;
	// Arm the station's own gate before the scheduler or the host sees the
	// abort: a started turn can deliver its next tool call immediately.
	station?.markOwnerRetired?.({
		batchId: batch.batchId,
		toolCallId,
		identity: ctx?.agent ?? null,
	});
	// The descriptor is the station's stop guard, not the scheduler's batch
	// object. Only the id crosses the port; the scheduler resolves its own
	// record from it.
	const port = registry.fissionScheduler?.();
	let outcome;
	try {
		outcome = port?.retireOwner?.({ batchId: batch.batchId, station, ctx });
	} catch (error) {
		station.lastError = String(error?.message ?? error);
		record("hooks", error, { fission: batch.batchId, retire: true });
	}
	// `ctx.agent` is only an ExtensionAgentIdentity, so the abort goes through
	// the context operation itself. The owner must not continue even when the
	// scheduler cannot witness it: running on would execute the work twice.
	if (outcome?.abort !== false) {
		try {
			ctx.abort();
		} catch (error) {
			record("hooks", error, { fission: batch.batchId, missing: ["ctx.abort"] });
		}
	}
	return true;
}

// A batch is live until the scheduler reports a terminal status. Prefer the
// per-batch probe: some schedulers implement `hasRunningFlows` process-wide
// and ignore the batch id, which would let an unrelated batch block this
// session's stop. A batch the scheduler no longer knows is finished.
const LIVE_BATCH_STATUSES = new Set([
	"registered",
	"starting",
	"running",
	"finalizing",
]);

function batchRunning(port, batch) {
	if (typeof port?.batchStatus === "function") {
		const status = port.batchStatus(batch.batchId)?.status;
		if (typeof status === "string") return LIVE_BATCH_STATUSES.has(status);
		return false;
	}
	if (typeof port?.hasRunningFlows === "function") {
		return port.hasRunningFlows(batch.batchId) === true;
	}
	return true;
}

/**
 * The capture map is keyed by the session manager, and fission flows share one
 * manager. Patching a session whose own agent id is a different flow would
 * route another flow's scope barrier, so the identity must agree before the
 * seam is installed. An unknown id keeps the existing session path.
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
export function wireHooks(pi, registry) {
	const bindDispatch = (ctx) => {
		const station = registry.stationFor(ctx);
		installScopeDispatch(
			dispatchSession(ctx),
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
	// `tool_result` is emitted inside the tool's own execute (wrapper.ts:541),
	// before agent-loop emits and commits this result. Aborting here cancels
	// the next model call; the loop still commits the completed tool's real
	// result (agent-loop.ts completedToolExecution path). Retirement therefore
	// never needs the Agent instance behind `ctx.agent`; the context aborts
	// its own operation.
	try {
		pi.on("tool_result", (event, ctx) => {
			const station = registry.stationFor(ctx);
			if (station?.fissionFlow?.endToolCallId === event?.toolCallId) {
				registry.fissionScheduler?.()?.retireEndedFlow?.(station.fissionFlow.id);
			}
			retirePendingBatch(station, registry, ctx, event?.toolCallId);
		});
	} catch (error) {
		record("hooks", error, { missing: ["tool_result"], optional: true });
	}
	hackContext(pi, (event, ctx) =>
		bindDispatch(ctx).onContext(event?.messages, ctx),
	);
	pi.on("before_agent_start", (event, ctx) => {
		const station = registry.stationFor(ctx);
		return station.onBeforeAgentStart(event, ctx);
	});
	pi.on("session_stop", (_event, ctx) => {
		const station = registry.stationForStop(ctx);
		if (station?.pendingFission && !station.fissionFlow) {
			const batch = station.pendingFission;
			const port = registry.fissionScheduler?.();
			let handled;
			try {
				handled = port?.onOwnerStop?.({ batchId: batch.batchId, station, ctx });
			} catch (error) {
				record("hooks", error, { fission: batch.batchId, stop: true });
			}
			if (handled !== undefined) return handled;
			// A batch is not complete while any flow runs. Saying so here keeps
			// the relay and the host from treating the owner's stop as the end.
			// Once the scheduler reports no live status the descriptor is spent,
			// so the normal stop gate decides instead of a stale batch.
			const running = batchRunning(port, batch);
			if (!running && station.pendingFission === batch) station.pendingFission = null;
			if (running) {
				return continueFeedback(
					`Fission batch ${batch.batchId} is still running. The owner has retired; the batch completes only when every flow has closed.`,
				);
			}
		}
		return station.onSessionStop(ctx);
	});
	// The host may expose `agent_end`; when it does, the scheduler starts the
	// flows only after the owner's receipt has been committed. A missing event
	// is not fatal, because the scheduler may subscribe to the agent itself.
	try {
		pi.on("agent_end", (event, ctx) => {
			const station = registry.stationFor(ctx);
			if (!station?.pendingFission || station.fissionFlow) return undefined;
			const batch = station.pendingFission;
			if (batch.retired !== true) return undefined;
			const port = registry.fissionScheduler?.();
			if (typeof port?.onOwnerEnd !== "function") return undefined;
			let outcome;
			try {
				outcome = port.onOwnerEnd({ batchId: batch.batchId, station, ctx, event });
			} catch (error) {
				record("hooks", error, { fission: batch.batchId, spawn: true });
				return undefined;
			}
			// The descriptor stays while the batch runs: `session_stop` needs it
			// to keep the owner's relay from finishing early, and clears it once
			// the scheduler reports no live status.
			return outcome;
		});
	} catch (error) {
		record("hooks", error, { missing: ["agent_end"], optional: true });
	}
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
