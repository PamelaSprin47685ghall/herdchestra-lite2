// Handoff debug tracing. Silent unless HERD_RELAY_DEBUG is set.

import { appendFileSync } from "node:fs";

const DEBUG_LOG_PATH = "/tmp/herd-relay-tui-debug.log";

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

export { DEBUG_LOG_PATH, debugEnabled, debugLog };
