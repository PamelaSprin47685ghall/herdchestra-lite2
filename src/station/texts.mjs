// Station texts: the model-facing nudge strings.

import { loadDoc, render } from "../prompts/index.mjs";
import { abandonedReturnNudge } from "../scope/return-nudge.mjs";

const T = loadDoc("receipts/scope");

/** A steer when a branch tries to stop with unreceived work. */
export function insideScopeNudge(openCount) {
	return render(T["scope.stop-blocked"], { count: openCount });
}

/** A steer when Root stops naturally inside a goal session before sealing. */
export function rootReturnNudge() {
	return T["root.return-nudge"];
}

/**
 * The one stop steer, chosen by mode.
 *
 * `FINAL_ANSWER` never steers: nothing is left to do but answer the user.
 * `ABANDONED` outranks `CONTEXT_LIMIT` and `unreceived`.
 */
export function stopNudge(mode, options = 0) {
	const opts =
		options && typeof options === "object"
			? options
			: { unreceived: Number(options) || 0 };
	const unreceived = Number.isInteger(opts.unreceived) ? opts.unreceived : 0;
	switch (mode) {
		case "ABANDONED":
			return abandonedReturnNudge({
				by: opts.abandoned?.by ?? opts.by ?? "/",
				reason: opts.abandoned?.reason ?? opts.reason ?? null,
			});
		case "CONTEXT_LIMIT":
			return T["mode.context-limit"];
		case "FINAL_ANSWER":
			return null;
		default:
			return unreceived > 0 ? insideScopeNudge(unreceived) : null;
	}
}
