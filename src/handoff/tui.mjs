// Handoff via the live TUI command, with a visible fallback signal.

import { interactiveCaptureState } from "../host/capture.mjs";
import { debugLog } from "./debug.mjs";
import { countHandoffCompactions, errorText } from "./session.mjs";

const TUI_HANDOFF_FLAG = Symbol.for("herdchestra-lite2.tui-handoff-in-flight");

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

export { TUI_HANDOFF_FLAG, renderTui, appendHandoffSignal, handoffViaTui };
