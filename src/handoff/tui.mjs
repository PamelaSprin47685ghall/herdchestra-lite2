// TUI transcript refresh and visible fallback signal after handoff.

import { debugLog } from "./debug.mjs";
import { errorText } from "./session.mjs";
import { appendHistoryMessage } from "../host/hack-context.mjs";

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
	if (appendHistoryMessage(manager, {
		role: "custom",
		customType: "herd-relay-handoff",
		display: true,
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	}, ctx)) {
		debugLog("handoff_signal", { via: "custom_message", generation });
		return true;
	}
	debugLog("handoff_signal.error", { via: "custom_message", generation });
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

export { renderTui, appendHandoffSignal };
