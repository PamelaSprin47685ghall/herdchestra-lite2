// Handoff perform: run the real handoff once and deliver the successor prompt.

import { handoffFor, interactiveCaptureState, tuiFor } from "../host/capture.mjs";
import {
	handoffFocus,
	handoffPendingNudge,
	successorPrompt,
} from "../relay/index.mjs";
import { continueFeedback } from "../tools/results.mjs";
import { debugLog } from "./debug.mjs";
import {
	countHandoffCompactions,
	callHandoffWithRecovery,
	errorText,
	isAlreadyCompacted,
	managerOf,
	safeSession,
} from "./session.mjs";
import { appendHandoffSignal, handoffViaTui, renderTui } from "./tui.mjs";

async function executeHandoff(session, focus, pi, ctx, station) {
	if (session && session.isGeneratingHandoff === true) {
		return { ok: true, inProgress: true };
	}
	debugLog("handoff.execute", {
		hasSession: Boolean(session),
		hasCapturedSession: Boolean(station.handoffSession),
		hasHandoffImpl: typeof pi?.handoffImpl === "function",
		generation: station.state.relay?.generation ?? null,
	});
	if (typeof pi?.handoffImpl === "function") {
		debugLog("handoff.call", {
			target: "handoffImpl",
			generation: station.state.relay?.generation ?? null,
		});
		const result = await pi.handoffImpl({ session, focus, rec: station, ctx });
		debugLog("handoff.result", {
			target: "handoffImpl",
			resultDefined: result !== undefined,
			ok: result?.ok ?? null,
		});
		if (result && result.ok === false) {
			throw new Error(String(result.error ?? result.reason ?? "handoff failed"));
		}
		return { ok: true };
	}
	const target = session ?? station.handoffSession ?? null;
	if (!target) {
		const bound = handoffFor(ctx);
		if (typeof bound !== "function") {
			debugLog("handoff.unavailable", {
				reason: "no-session-or-bound-handoff",
			});
			throw new Error(
				"Cannot capture the live AgentSession; handoff did not start. Fix AgentSession.prototype.prompt/extensionRunner capture; do not degrade to sendUserMessage, newSession, or a nudge.",
			);
		}
		debugLog("handoff.call", {
			target: "bound",
			generation: station.state.relay?.generation ?? null,
		});
		await bound(focus);
		debugLog("handoff.result", { target: "bound", resultDefined: true });
		return { ok: true };
	}
	if (typeof target.handoff !== "function") {
		const bound = handoffFor(ctx);
		if (typeof bound !== "function") {
			debugLog("handoff.unavailable", {
				reason: "captured-session-has-no-handoff",
			});
			throw new Error(
				"The captured session has no handoff() method and no bound handoff is available.",
			);
		}
		debugLog("handoff.call", {
			target: "bound-fallback",
			generation: station.state.relay?.generation ?? null,
		});
		await bound(focus);
		debugLog("handoff.result", {
			target: "bound-fallback",
			resultDefined: true,
		});
		return { ok: true };
	}
	debugLog("handoff.call", {
		target: "AgentSession.handoff",
		generation: station.state.relay?.generation ?? null,
		focusChars: focus.length,
	});
	const result = await callHandoffWithRecovery(target, focus);
	debugLog("handoff.result", {
		target: "AgentSession.handoff",
		resultDefined: result !== undefined,
		generation: station.state.relay?.generation ?? null,
	});
	if (result === undefined && !station.handoffAdvanced) {
		throw new Error("AgentSession.handoff() returned undefined (cancelled or failed).");
	}
	return { ok: true };
}

/**
 * Deliver the successor prompt through the mode-appropriate channel.
 * A print-mode continuation becomes the hidden next turn, so the process does
 * not exit before the successor evaluates the ledger.
 */
function deliverSuccessor(station, ctx) {
	const target = station.relayPromptPendingFor;
	if (!Number.isInteger(target)) {
		debugLog("successor.skipped", {
			reason: "no-pending-target",
			generation: station.state.relay?.generation ?? null,
		});
		return undefined;
	}
	if (station.relayPromptSentFor === target) {
		debugLog("successor.skipped", { reason: "already-sent", target });
		return undefined;
	}
	const relay = station.state.relay;
	if (!relay || relay.generation !== target) {
		debugLog("successor.skipped", {
			reason: "generation-mismatch",
			target,
			generation: relay?.generation ?? null,
		});
		return undefined;
	}
	const prompt = successorPrompt(relay, relay.lastLedger ?? null);
	station.relayPromptSentFor = target;
	station.relayPromptPendingFor = null;
	debugLog("successor.delivered", {
		generation: target,
		promptChars: prompt.length,
	});
	return { continue: true, additionalContext: prompt };
}

async function performHandoff(station, ctx, pi, options = {}) {
	if (station.handoffExecuting) {
		return { ok: true, inProgress: true };
	}
	const focus =
		typeof station.handoffFocus === "string" && station.handoffFocus
			? station.handoffFocus
			: handoffFocus(station.state.relay);
	let result;
	let manager = null;
	let signalNeeded = false;
	station.handoffExecuting = true;
	try {
		const session = safeSession(ctx) ?? station.handoffSession ?? null;
		manager = managerOf(session, ctx);
		let tui = null;
		try {
			tui = tuiFor();
		} catch {
			tui = null;
		}
		const canRunTuiCommand =
			options.preferTui !== false &&
			Boolean(tui) &&
			typeof tui.handleHandoffCommand === "function";
		debugLog("tui_capture", {
			hasTui: Boolean(tui),
			canHandoff: canRunTuiCommand,
			canRender: typeof tui?.renderInitialMessages === "function",
			capture: interactiveCaptureState(),
			generation: station.state.relay?.generation ?? null,
		});
		if (canRunTuiCommand) {
			const viaTui = await handoffViaTui(tui, manager, focus, station);
			if (viaTui.inProgress) {
				return continueFeedback(handoffPendingNudge(station.state.relay));
			}
			if (viaTui.ok) {
				debugLog("handoff.path", { path: "tui", generation: station.state.relay?.generation ?? null });
				result = { ok: true, viaTui: true };
			} else {
				// The built-in command may swallow its own failure. Fall back to the
				// real AgentSession.handoff() (with short-session recovery) and then
				// rebuild the transcript ourselves. The compaction count decides.
				debugLog("tui_handoff_fallback", {
					reason: viaTui.reason,
					before: viaTui.before,
					after: viaTui.after,
					error: viaTui.error,
				});
				result = await executeHandoff(session, focus, pi, ctx, station);
				const rendered = await renderTui(tui);
				if (!rendered) signalNeeded = true;
				const afterFallback = countHandoffCompactions(manager);
				debugLog("compaction_entry", {
					path: "tui-fallback",
					before: viaTui.before,
					after: afterFallback,
				});
				if (
					!result?.inProgress &&
					viaTui.before !== null &&
					afterFallback !== null &&
					afterFallback <= viaTui.before
				) {
					const detail = viaTui.error
						? ` TUI handler error: ${viaTui.error}.`
						: "";
					throw new Error(
						`handoff did not add a compaction entry (method=handoff; ${viaTui.before} -> ${afterFallback}). The TUI handler did not perform the real session handoff.${detail}`,
					);
				}
			}
		} else {
			result = await executeHandoff(session, focus, pi, ctx, station);
			const rendered = await renderTui(tui);
			const after = countHandoffCompactions(manager);
			debugLog("compaction_entry", { path: "direct", before: null, after });
			// No TUI rebuild means the divider cannot appear. Leave a real,
			// displayable session entry so the user still sees the handoff.
			if (!rendered) signalNeeded = true;
		}
	} catch (error) {
		debugLog("handoff.error", {
			error: errorText(error),
			generation: station.state.relay?.generation ?? null,
		});
		// "Nothing to hand off (already compacted)" is a terminal success, not a
		// retryable failure: the host has no compressible tail left, so the
		// handoff is already done. Advance at most once and clear pending, or
		// the successor and every tool guarded by handoffPending stay stuck.
		if (isAlreadyCompacted(error)) {
			const compacted = station.finishCompactedHandoff();
			debugLog("handoff.already_compacted", {
				advanced: compacted.advanced,
				generation: compacted.generation,
			});
			return {
				ok: true,
				alreadyCompacted: true,
				advanced: compacted.advanced,
				generation: compacted.generation,
			};
		}
		station.recordHandoffFailureAt(error, Date.now());
		return { ok: false, error: errorText(error) };
	} finally {
		station.handoffExecuting = false;
	}
	if (result?.inProgress) {
		debugLog("handoff.in-progress", {
			generation: station.state.relay?.generation ?? null,
		});
		return { ok: true, inProgress: true };
	}
	const advanced = station.advanceRelayForHandoff();
	const alreadyAdvanced =
		station.handoffAdvanced === true &&
		Number.isInteger(station.relayPromptPendingFor) &&
		station.state.relay?.generation === station.relayPromptPendingFor;
	if (!advanced && !alreadyAdvanced) {
		const error = new Error("handoff completed but relay did not advance");
		station.recordHandoffFailureAt(error, Date.now());
		return { ok: false, error: error.message };
	}
	if (signalNeeded) {
		appendHandoffSignal(manager, ctx, station.state.relay?.generation ?? 0);
	}
	station.persist();
	return { ok: true, advanced, generation: station.state.relay?.generation ?? 0 };
}

export { executeHandoff, deliverSuccessor, performHandoff };
