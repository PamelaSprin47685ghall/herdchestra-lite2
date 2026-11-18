// Real /handoff integration for the running omp 18.16 runtime.
//
// The installed CLI is 18.16: `AgentSession.handoff()` appends a compaction in
// place. It does NOT create a new session, does NOT emit session_switch, and a
// manual handoff does not emit auto_compaction_end. The reliable execution
// point is the main session's `session_stop` hook:
//   - every mode: return { continue: true, additionalContext }
//   - only canStop returns undefined, which allows the host to stop.
//
// The todo tool only marks `relay.handoffPending`. It never calls the host in
// its execute body, so no mode can deadlock on a streaming session. The 17.3.5
// new-session branch and 18.18.2 auto-compaction events remain as
// feature-detected evidence, but the awaited call is the main path.
//
// The live AgentSession is captured at todo time and carried on the record.
// Some hosts build a fresh extension context for session_stop; relying only on
// ctx.sessionManager there loses both the relay record and the session. The
// module-level `pending` record is the unambiguous main-session fallback.
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

import { currentScope } from "./engine.mjs";
import {
	beginGenerationAfterHandoff,
	firstEvaluationNudge,
	handoffFailureNudge,
	handoffFocus,
	handoffPendingNudge,
	openLedgerNudge,
	recordHandoffFailure,
	successorPrompt,
} from "./relay.mjs";
import {
	handoffFor,
	interactiveCaptureState,
	sessionFor,
	tuiFor,
} from "./runner-capture.mjs";

const KEEP_RECENT_KEY = "compaction.keepRecentTokens";
const DEBUG_LOG_PATH = "/tmp/herd-relay-tui-debug.log";
const TUI_HANDOFF_FLAG = Symbol.for("herdchestra-lite2.tui-handoff-in-flight");

// The main session's pending handoff. There is one at a time; this survives a
// session_stop context that cannot resolve the same SessionManager.
let pending = null;

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

function persist(rec) {
	try {
		rec?.persist?.();
	} catch {
		// Persistence failure must not turn a real handoff into a fake success.
	}
}

/**
 * Deliver the successor prompt through the mode-appropriate channel.
 * A print-mode continuation becomes the hidden next turn, so the process does
 * not exit before the successor evaluates the ledger.
 */
function deliverSuccessor(rec, ctx, pi) {
	const target = rec.relayPromptPendingFor;
	if (!Number.isInteger(target)) {
		debugLog("successor.skipped", {
			reason: "no-pending-target",
			generation: rec.state.relay?.generation ?? null,
		});
		return undefined;
	}
	if (rec.relayPromptSentFor === target) {
		debugLog("successor.skipped", { reason: "already-sent", target });
		return undefined;
	}
	const relay = rec.state.relay;
	if (!relay || relay.generation !== target) {
		debugLog("successor.skipped", {
			reason: "generation-mismatch",
			target,
			generation: relay?.generation ?? null,
		});
		return undefined;
	}
	const prompt = successorPrompt(relay, relay.lastLedger ?? null);
	rec.relayPromptSentFor = target;
	rec.relayPromptPendingFor = null;
	debugLog("successor.delivered", {
		generation: target,
		promptChars: prompt.length,
	});
	return { continue: true, additionalContext: prompt };
}

function feedback(_ctx, _pi, text) {
	if (!text) return undefined;
	return { continue: true, additionalContext: text };
}

/**
 * Advance exactly once. The awaited handoff call and the 17.3.5 switch event
 * can both reach this function; only the first one increments the generation.
 */
function advanceRelayForHandoff(rec) {
	if (rec.handoffAdvanced) return false;
	const relay = rec.state.relay;
	if (!relay || !relay.handoffPending || relay.canStop) return false;
	rec.state.relay = beginGenerationAfterHandoff(relay, {
		at: Date.now(),
		fromGeneration: relay.generation,
	});
	rec.handoffAdvanced = true;
	rec.relayPromptPendingFor = rec.state.relay.generation;
	rec.relayPromptSentFor = null;
	persist(rec);
	return true;
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
async function handoffViaTui(tui, manager, focus, rec) {
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
			// The command guard is best effort; rec.handoffExecuting still holds.
		}
	}
	let callError = null;
	let returned = false;
	debugLog("tui_handoff_call", {
		before,
		generation: rec.state.relay?.generation ?? null,
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
		generation: rec.state.relay?.generation ?? null,
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
	try {
		manager.appendMessage({
			role: "user",
			content: [
				{
					type: "text",
					text: "Relay handoff audit checkpoint. The previous holder's ledger was empty; the successor must verify it with todo.",
				},
			],
			timestamp: Date.now(),
		});
		return true;
	} catch {
		return false;
	}
}

async function executeHandoff(session, focus, pi, ctx, rec) {
	if (session && session.isGeneratingHandoff === true) {
		return { ok: true, inProgress: true };
	}
	debugLog("handoff.execute", {
		hasSession: Boolean(session),
		hasCapturedSession: Boolean(rec.handoffSession),
		hasHandoffImpl: typeof pi?.handoffImpl === "function",
		generation: rec.state.relay?.generation ?? null,
	});
	if (typeof pi?.handoffImpl === "function") {
		debugLog("handoff.call", {
			target: "handoffImpl",
			generation: rec.state.relay?.generation ?? null,
		});
		const result = await pi.handoffImpl({ session, focus, rec, ctx });
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
	const target = session ?? rec.handoffSession ?? null;
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
			generation: rec.state.relay?.generation ?? null,
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
			generation: rec.state.relay?.generation ?? null,
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
		generation: rec.state.relay?.generation ?? null,
		focusChars: focus.length,
	});
	const result = await callHandoffWithRecovery(target, focus);
	debugLog("handoff.result", {
		target: "AgentSession.handoff",
		resultDefined: result !== undefined,
		generation: rec.state.relay?.generation ?? null,
	});
	if (result === undefined && !rec.handoffAdvanced) {
		throw new Error("AgentSession.handoff() returned undefined (cancelled or failed).");
	}
	return { ok: true };
}

function insideScopeText(rec) {
	const scope = currentScope(rec.state);
	if (!scope) return "";
	return `You are still inside scope level ${rec.state.scopes.length}: ${JSON.stringify(scope.intent)}. Do not write the final user-facing conclusion. Continue the task or close the scope. todo is forbidden inside every scope; close every scope before evaluating the ledger.`;
}

async function runHandoffAtStop(rec, ctx, pi) {
	if (rec.handoffExecuting) {
		return feedback(ctx, pi, handoffPendingNudge(rec.state.relay));
	}
	const focus =
		typeof rec.handoffFocus === "string" && rec.handoffFocus
			? rec.handoffFocus
			: handoffFocus(rec.state.relay);
	let result;
	let manager = null;
	let signalNeeded = false;
	rec.handoffExecuting = true;
	try {
		const session = safeSession(ctx) ?? rec.handoffSession ?? null;
		manager = managerOf(session, ctx);
		let tui = null;
		try {
			tui = tuiFor();
		} catch {
			tui = null;
		}
		const canRunTuiCommand =
			Boolean(tui) && typeof tui.handleHandoffCommand === "function";
		debugLog("tui_capture", {
			hasTui: Boolean(tui),
			canHandoff: canRunTuiCommand,
			canRender: typeof tui?.renderInitialMessages === "function",
			capture: interactiveCaptureState(),
			generation: rec.state.relay?.generation ?? null,
		});
		if (canRunTuiCommand) {
			const viaTui = await handoffViaTui(tui, manager, focus, rec);
			if (viaTui.inProgress) {
				return feedback(ctx, pi, handoffPendingNudge(rec.state.relay));
			}
			if (viaTui.ok) {
				debugLog("handoff.path", { path: "tui", generation: rec.state.relay?.generation ?? null });
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
				result = await executeHandoff(session, focus, pi, ctx, rec);
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
			result = await executeHandoff(session, focus, pi, ctx, rec);
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
			generation: rec.state.relay?.generation ?? null,
		});
		rec.state.relay = recordHandoffFailure(rec.state.relay, error, {
			at: Date.now(),
		});
		persist(rec);
		return feedback(ctx, pi, handoffFailureNudge(error));
	} finally {
		rec.handoffExecuting = false;
	}
	if (result?.inProgress) {
		debugLog("handoff.in-progress", {
			generation: rec.state.relay?.generation ?? null,
		});
		return feedback(ctx, pi, handoffPendingNudge(rec.state.relay));
	}
	const advanced = advanceRelayForHandoff(rec);
	const alreadyAdvanced =
		rec.handoffAdvanced === true &&
		Number.isInteger(rec.relayPromptPendingFor) &&
		rec.state.relay?.generation === rec.relayPromptPendingFor;
	if (!advanced && !alreadyAdvanced) {
		const error = new Error("handoff completed but relay did not advance");
		rec.state.relay = recordHandoffFailure(rec.state.relay, error, {
			at: Date.now(),
		});
		persist(rec);
		return feedback(ctx, pi, handoffFailureNudge(error));
	}
	if (signalNeeded) {
		appendHandoffSignal(manager, ctx, rec.state.relay?.generation ?? 0);
	}
	persist(rec);
	return deliverSuccessor(rec, ctx, pi);
}

/**
 * Main session_stop handler. Every branch that must not stop returns a
 * session_stop continuation; only canStop allows a natural stop.
 */
async function handleSessionStopBody(rec, ctx, pi) {
	if (rec.sessionStopRunning) {
		return {
			continue: true,
			additionalContext: "A session_stop pass is already running; wait.",
		};
	}
	rec.sessionStopRunning = true;
	try {
		const scope = currentScope(rec.state);
		if (scope) return feedback(ctx, pi, insideScopeText(rec));
		const relay = rec.state.relay;
		if (!relay) return feedback(ctx, pi, firstEvaluationNudge());
		if (relay.canStop) return undefined;
		if (relay.handoffPending) {
			return await runHandoffAtStop(rec, ctx, pi);
		}
		if (!relay.lastLedger) {
			return feedback(ctx, pi, firstEvaluationNudge());
		}
		// The empty ledger after a handoff belongs to the previous generation.
		// The successor must evaluate first; only its result can trigger the
		// next handoff.
		if (relay.generation > 0 && relay.firstEvaluation === null) {
			return feedback(ctx, pi, firstEvaluationNudge());
		}
		if (relay.lastLedger.empty) {
			rec.handoffFocus = handoffFocus({ ...relay, handoffPending: true });
			rec.handoffAdvanced = false;
			rec.handoffSwitched = false;
			rec.state.relay = { ...relay, handoffPending: true };
			persist(rec);
			return await runHandoffAtStop(rec, ctx, pi);
		}
		return feedback(ctx, pi, openLedgerNudge(relay, relay.lastLedger));
	} finally {
		rec.sessionStopRunning = false;
	}
}

export async function handleSessionStop(rec, ctx, pi) {
	const before = rec?.state?.relay ?? null;
	debugLog("session_stop.enter", {
		mode: ctx?.mode ?? rec?.mode ?? null,
		generation: before?.generation ?? null,
		handoffPending: before?.handoffPending ?? null,
		canStop: before?.canStop ?? null,
	});
	let result;
	try {
		result = await handleSessionStopBody(rec, ctx, pi);
	} catch (error) {
		debugLog("session_stop.error", {
			error: errorText(error),
			generation: rec?.state?.relay?.generation ?? null,
		});
		throw error;
	}
	const after = rec?.state?.relay ?? null;
	const context =
		typeof result?.additionalContext === "string"
			? result.additionalContext
			: "";
	debugLog("session_stop.exit", {
		continuation: result !== undefined,
		successorPromptDelivered: context.includes("You are the relay successor"),
		relayPromptSentFor: rec?.relayPromptSentFor ?? null,
		relayPromptPendingFor: rec?.relayPromptPendingFor ?? null,
		generation: after?.generation ?? null,
		handoffPending: after?.handoffPending ?? null,
		canStop: after?.canStop ?? null,
		handoffError: after?.handoffError ?? null,
	});
	return result;
}

/**
 * Mark that an empty ledger must hand off. This is deliberately only a state
 * change: the actual host call happens in session_stop.
 */
export function requestHandoff(ctx, _pi, rec, options = {}) {
	if (!rec?.state?.relay) {
		return { ok: false, error: "relay state is missing" };
	}
	const relay = rec.state.relay;
	if (relay.canStop) {
		return { ok: true, skipped: "promoted", generation: relay.generation };
	}
	rec.handoffFocus =
		options.focus ??
		handoffFocus({ ...relay, handoffPending: true });
	rec.handoffSession = safeSession(ctx) ?? rec.handoffSession ?? null;
	// One pending main-session handoff at a time. This survives a session_stop
	// context that cannot resolve the same SessionManager.
	pending = rec;
	if (relay.handoffPending) {
		// applyLedgerEvaluation sets handoffPending itself. A new empty-ledger
		// decision arrives here with pending already true, so clear the previous
		// generation's completion flag before the stop hook advances.
		if (!rec.handoffExecuting) {
			rec.handoffAdvanced = false;
			rec.handoffSwitched = false;
		}
		return {
			ok: true,
			pending: true,
			inProgress: true,
			generation: relay.generation,
		};
	}
	rec.handoffAdvanced = false;
	rec.handoffSwitched = false;
	rec.state.relay = { ...relay, handoffPending: true, handoffError: null };
	persist(rec);
	return {
		ok: true,
		pending: true,
		generation: rec.state.relay.generation,
	};
}

function isHandoffCompaction(event) {
	if (!event || typeof event !== "object") return false;
	if (event.handoff === true || event.isHandoff === true) return true;
	const action =
		event.action ??
		event.compaction?.action ??
		event.reason ??
		event.source ??
		event.kind;
	return action === "handoff";
}

/**
 * Register the stop hook and the two feature-detected transition events.
 * Nothing here calls handoff in agent_end: 18.16 unwinds and aborts a handoff
 * started from that notification.
 */
export function installHandoffHooks(pi, options = {}) {
	const lookup = typeof options.stateFor === "function" ? options.stateFor : null;
	if (!lookup) return;
	const recordFor = (ctx) => {
		try {
			return lookup(ctx) ?? null;
		} catch {
			return null;
		}
	};
	const pendingRecord = (ctx) => {
		const current = recordFor(ctx);
		if (current?.state?.relay?.handoffPending) return current;
		if (pending?.state?.relay?.handoffPending) return pending;
		return current;
	};
	const register = (event, handler) => {
		try {
			pi?.on?.(event, handler);
		} catch {
			// The host does not expose this event; the stop hook remains.
		}
	};
	register("session_stop", async (_event, ctx) => {
		const rec = pendingRecord(ctx);
		if (!rec) return undefined;
		return handleSessionStop(rec, ctx, pi);
	});
	// 17.3.5 creates a new session. Its switch event is the only evidence that
	// the custom scope.state entry must be re-appended to the new branch.
	register("session_switch", (event, ctx) => {
		const rec = pendingRecord(ctx);
		if (!rec?.handoffExecuting) return;
		const reason = event?.reason ?? event?.handoffReason;
		if (reason !== "handoff" && event?.handoff !== true) return;
		advanceRelayForHandoff(rec);
		persist(rec);
	});
	// 18.18.2 compacts in place and marks the event. 18.16 does not emit it for
	// a manual handoff; when present, it only confirms an in-flight call.
	register("auto_compaction_end", (event, ctx) => {
		if (!isHandoffCompaction(event)) return;
		const rec = pendingRecord(ctx);
		if (!rec?.handoffExecuting) return;
		advanceRelayForHandoff(rec);
		persist(rec);
	});
}
