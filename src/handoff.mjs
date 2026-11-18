// Real /handoff integration for the running omp 18.16 runtime.
//
// The installed CLI is 18.16: `AgentSession.handoff()` appends a compaction in
// place. It does NOT create a new session, does NOT emit session_switch, and a
// manual handoff does not emit auto_compaction_end.
//
// The empty-ledger todo only marks the relay pending on the SessionStation. The
// next `context` hook is the interrupt point: it runs the real handoff and
// returns the post-handoff messages. Replacing the request messages is the
// interrupt; do not call ctx.abort(), because AgentSession.abort() cancels the
// in-flight handoff.
//
// `session_stop` remains the retry path: after a context failure, or when the
// host cannot run the call there, the stop gatekeeper returns a sessionStop
// ticket that runs the real handoff and yields the one continuation the host
// accepts. Only canStop returns undefined, which allows the host to stop. The
// 17.3.5 new-session branch and 18.18.2 auto-compaction events remain as
// feature-detected evidence handled by station gatekeepers.
//
// The live AgentSession is captured at todo time and carried on the station.
// Some hosts build a fresh extension context for session_stop; relying only on
// ctx.sessionManager there loses both the relay record and the session. The
// station registry's pending station is the unambiguous main-session fallback.
//
// TUI debugging is silent by default. Set HERD_RELAY_DEBUG=1 to append JSON
// lines to /tmp/herd-relay-tui-debug.log:
//   HERD_RELAY_DEBUG=1 omp ...
// A session_stop entry records mode, generation, handoffPending and canStop.
// Handoff events record whether the real AgentSession.handoff() was called
// and its result or error. The exit event records whether a continuation was
// returned and whether the successor prompt was delivered. Tracing never
// changes normal behavior or tool results.

import { appendFileSync } from "node:fs";

import {
	handoffFailureNudge,
	handoffFocus,
	handoffPendingNudge,
	successorPrompt,
} from "./relay.mjs";
import { continueFeedback } from "./results.mjs";
import {
	handoffFor,
	interactiveCaptureState,
	sessionFor,
	tuiFor,
} from "./runner-capture.mjs";

const KEEP_RECENT_KEY = "compaction.keepRecentTokens";
const DEBUG_LOG_PATH = "/tmp/herd-relay-tui-debug.log";
const TUI_HANDOFF_FLAG = Symbol.for("herdchestra-lite2.tui-handoff-in-flight");

function debugEnabled() {
	const value = process.env.HERD_RELAY_DEBUG;
	return Boolean(value) && value !== "0" && value !== "false";
}

function debugLog(event, fields = {}) {
	if (!debugEnabled()) return;
	let line;
	try {
		line = JSON.stringify({ at: new Date().toISOString(), event, ...fields });
	} catch {
		line = JSON.stringify({ at: new Date().toISOString(), event });
	}
	try {
		appendFileSync(DEBUG_LOG_PATH, `${line}\n`);
	} catch {
		// Tracing must never change handoff behavior.
	}
}

function safeSession(ctx) {
	try {
		return sessionFor(ctx);
	} catch {
		return null;
	}
}

function errorText(error) {
	return String(error?.message ?? error ?? "handoff failed");
}

function isAlreadyCompacted(error) {
	const message = errorText(error);
	if (/already compacted/i.test(message)) return true;
	return /nothing to hand off/i.test(message) && !/no messages yet/i.test(message);
}

/**
 * Count handoff compactions on the live branch. The host writes
 * `{ type: "compaction", method: "handoff" }`; older builds carry the method in
 * `details`. A null result means the manager cannot answer, so callers must not
 * treat "no count" as "no handoff".
 */
export function countHandoffCompactions(manager) {
	if (!manager || typeof manager.getBranch !== "function") return null;
	try {
		const branch = manager.getBranch();
		if (!Array.isArray(branch)) return null;
		let count = 0;
		for (const entry of branch) {
			if (!entry || entry.type !== "compaction") continue;
			const method = entry.method ?? entry.details?.method;
			if (method === "handoff") count += 1;
		}
		return count;
	} catch {
		return null;
	}
}

function managerOf(session, ctx) {
	try {
		if (session?.sessionManager) return session.sessionManager;
	} catch {
		// Fall through to the extension context.
	}
	try {
		return ctx?.sessionManager ?? null;
	} catch {
		return null;
	}
}

async function renderTui(tui) {
	if (!tui || typeof tui.renderInitialMessages !== "function") return false;
	try {
		await tui.renderInitialMessages();
		debugLog("tui_render", { ok: true });
		return true;
	} catch (error) {
		debugLog("tui_render", { ok: false, error: errorText(error) });
		return false;
	}
}

/**
 * Fallback visible signal when the TUI cannot rebuild its transcript. A custom
 * message is a real session entry, so a reload and the next turn both see it.
 */
function appendHandoffSignal(manager, ctx, generation) {
	const text = `Handoff complete: generation ${generation} -> successor evaluating`;
	try {
		if (manager && typeof manager.appendMessage === "function") {
			manager.appendMessage({
				role: "custom",
				customType: "herd-relay-handoff",
				display: true,
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			});
			debugLog("handoff_signal", { via: "custom_message", generation });
			return true;
		}
	} catch (error) {
		debugLog("handoff_signal.error", {
			via: "custom_message",
			error: errorText(error),
		});
	}
	try {
		const ui = ctx?.ui;
		if (ui && typeof ui.showStatus === "function") {
			ui.showStatus(text);
			debugLog("handoff_signal", { via: "show_status", generation });
			return true;
		}
	} catch (error) {
		debugLog("handoff_signal.error", {
			via: "show_status",
			error: errorText(error),
		});
	}
	return false;
}

/**
 * Run the host's built-in handoff command, which calls the real
 * AgentSession.handoff() and then rebuilds the TUI transcript. The command
 * returns void and may swallow its own errors, so success is decided only by a
 * new `method: "handoff"` compaction entry on the branch.
 */
async function handoffViaTui(tui, manager, focus, station) {
	const before = countHandoffCompactions(manager);
	const captureBefore = interactiveCaptureState();
	if (before === null) {
		return { ok: false, reason: "compaction-count-unavailable", before };
	}
	if (tui[TUI_HANDOFF_FLAG]) {
		return { inProgress: true, before };
	}
	try {
		Object.defineProperty(tui, TUI_HANDOFF_FLAG, {
			value: true,
			configurable: true,
		});
	} catch {
		try {
			tui[TUI_HANDOFF_FLAG] = true;
		} catch {
			// The command guard is best effort; station.handoffExecuting still holds.
		}
	}
	let callError = null;
	let returned = false;
	debugLog("tui_handoff_call", {
		before,
		generation: station.state.relay?.generation ?? null,
		focusChars: focus.length,
	});
	try {
		await tui.handleHandoffCommand(focus);
		returned = true;
	} catch (error) {
		callError = errorText(error);
	} finally {
		try {
			delete tui[TUI_HANDOFF_FLAG];
		} catch {
			// A frozen instance is left marked; the next stop reports in progress.
		}
	}
	const after = countHandoffCompactions(manager);
	const captureAfter = interactiveCaptureState();
	const ok = after !== null && after > before;
	debugLog("tui_handoff_result", {
		before,
		after,
		ok,
		returned,
		rendersBefore: captureBefore.renders,
		rendersAfter: captureAfter.renders,
		error: callError,
		generation: station.state.relay?.generation ?? null,
	});
	debugLog("compaction_entry", { path: "tui", before, after });
	if (callError) debugLog("tui_handoff_error", { error: callError, before, after });
	return {
		ok,
		before,
		after,
		error: callError,
		reason: ok ? null : callError ? "tui-handler-error" : "no-new-compaction-entry",
	};
}

/**
 * A manual handoff on a very small or already compacted branch fails with
 * "Nothing to hand off (already compacted)". First append a real user
 * checkpoint: it forms a compressible tail without changing settings. Only if
 * that still fails, re-run with a temporary keepRecentTokens=1 and restore the
 * user's setting in `finally`. Never make the change permanent.
 */
async function callHandoffWithRecovery(session, focus) {
	let firstError;
	try {
		return await session.handoff(focus);
	} catch (error) {
		if (!isAlreadyCompacted(error)) throw error;
		firstError = error;
	}
	let checkpointError = null;
	if (appendHandoffCheckpoint(session)) {
		try {
			return await session.handoff(focus);
		} catch (error) {
			if (!isAlreadyCompacted(error)) throw error;
			checkpointError = error;
		}
	}
	const settings = session?.settings;
	const canAdjust =
		settings &&
		typeof settings.get === "function" &&
		typeof settings.set === "function";
	const previous = canAdjust ? settings.get(KEEP_RECENT_KEY) : undefined;
	let adjusted = false;
	if (canAdjust) {
		try {
			settings.set(KEEP_RECENT_KEY, 1);
			adjusted = true;
		} catch {
			// No setting change means no third attempt.
		}
	}
	if (!adjusted) throw checkpointError ?? firstError;
	try {
		return await session.handoff(focus);
	} finally {
		try {
			settings.set(KEEP_RECENT_KEY, previous);
		} catch {
			// Restore is best effort; the real error is already surfaced.
		}
	}
}

function appendHandoffCheckpoint(session) {
	const manager = session?.sessionManager;
	if (!manager || typeof manager.appendMessage !== "function") return false;
	const message = {
		role: "user",
		content: [
			{
				type: "text",
				text: "Relay handoff audit checkpoint. The previous holder's ledger was empty; the successor must verify it with todo.",
			},
		],
		timestamp: Date.now(),
	};
	try {
		manager.appendMessage(message);
	} catch {
		return false;
	}
	// The compaction reads the live agent transcript, not only the session
	// manager. Keep them aligned, or the checkpoint never forms a compressible
	// tail and the retry fails with "already compacted" again.
	try {
		const messages = session?.agent?.state?.messages;
		if (Array.isArray(messages) && !messages.includes(message)) {
			messages.push(message);
		}
	} catch {
		// A host without a live agent still got the manager entry.
	}
	return true;
}

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

/**
 * Session-stop handoff runner. Runs the real handoff once and turns the
 * outcome into the one continuation the host accepts; failure retries.
 */
async function runHandoffAtStop(station, ctx, pi) {
	const outcome = await performHandoff(station, ctx, pi);
	if (outcome?.inProgress) {
		return continueFeedback(handoffPendingNudge(station.state.relay));
	}
	if (outcome?.ok === false) {
		return continueFeedback(handoffFailureNudge(outcome.error));
	}
	return deliverSuccessor(station, ctx);
}

/**
 * Run the real handoff from the context hook, after the caller interrupts the
 * turn that would otherwise ask the model for a useless "ready to hand off"
 * reply. The context hook returns the post-handoff messages so the provider
 * request is already the successor's first turn. The TUI command path is
 * skipped because its command rebuilds the transcript and may re-enter the
 * active turn; the direct AgentSession.handoff() path still renders afterwards.
 */
export async function runHandoffInContext(station, ctx, pi) {
	const liveSession = safeSession(ctx) ?? station.handoffSession ?? null;
	const liveManager = managerOf(liveSession, ctx);
	if (liveManager && typeof liveManager.getBranch === "function") {
		try {
			const messageEntries = liveManager
				.getBranch()
				.filter((entry) => entry?.type === "message");
			// The host refuses a handoff before its second message. The tool
			// result is not on the branch yet, so a fresh session can only fail;
			// let session_stop retry after the turn appends its messages.
			if (messageEntries.length < 2) {
				return {
					ok: false,
					error:
						"too few messages for a context handoff; session_stop will retry",
				};
			}
		} catch {
			// Fall through to the real call.
		}
	}
	const outcome = await performHandoff(station, ctx, pi, { preferTui: false });
	if (outcome?.inProgress) {
		return { ok: false, pending: true, error: "handoff is already in progress" };
	}
	if (outcome?.ok === false) return { ok: false, error: outcome.error };
	return { ok: true, generation: outcome.generation };
}

/**
 * Session-stop ticket. The stop gatekeeper has already decided that a handoff
 * must run (relay.handoffPending or an empty ledger after arming); this ticket
 * performs it exactly once and yields the continuation. Only canStop, decided
 * by the gatekeeper, allows a natural stop.
 */
export async function sessionStopTicket(station, ctx, pi) {
	const before = station.state.relay ?? null;
	debugLog("session_stop.enter", {
		mode: ctx?.mode ?? null,
		generation: before?.generation ?? null,
		handoffPending: before?.handoffPending ?? null,
		canStop: before?.canStop ?? null,
	});
	station.sessionStopRunning = true;
	let result;
	try {
		result = await runHandoffAtStop(station, ctx, pi);
	} catch (error) {
		debugLog("session_stop.error", {
			error: errorText(error),
			generation: station.state.relay?.generation ?? null,
		});
		throw error;
	} finally {
		station.sessionStopRunning = false;
	}
	const after = station.state.relay ?? null;
	const context =
		typeof result?.additionalContext === "string"
			? result.additionalContext
			: "";
	debugLog("session_stop.exit", {
		continuation: result !== undefined,
		successorPromptDelivered: context.includes("You are the relay successor"),
		relayPromptSentFor: station.relayPromptSentFor ?? null,
		relayPromptPendingFor: station.relayPromptPendingFor ?? null,
		generation: after?.generation ?? null,
		handoffPending: after?.handoffPending ?? null,
		canStop: after?.canStop ?? null,
		handoffError: after?.handoffError ?? null,
	});
	return result;
}
