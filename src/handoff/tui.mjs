// TUI transcript refresh after handoff.

import { debugLog } from "./debug.mjs";
import { errorText } from "./session.mjs";

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

export { renderTui };
