// Station texts: the model-facing nudge strings.
//
// The per-turn REPL probe is owned by `domain/capabilities.mjs`; this module
// keeps only the steers the station delivers when the model tries to stop
// against a hard mode. A hard mode already removed every other tool from
// `api`, so a steer only has to name the one move that remains.

import { loadDoc, render } from "../prompts/index.mjs";

const T = loadDoc("receipts/scope");

/** A steer when a branch tries to stop with unreceived work. */
export function insideScopeNudge(openCount) {
	return render(T["scope.stop-blocked"], { count: openCount });
}

/** A steer when Root stops naturally under autopilot before sealing. */
export function rootReturnNudge() {
	return T["root.return-nudge"];
}

/**
 * The one stop steer, chosen by mode.
 *
 * `FINAL_ANSWER` never steers: nothing is left to do but answer the user.
 * `AWAITING_REPLY` outranks `CONTEXT_LIMIT` exactly as it does in the
 * projection, so a half-full scope still unblocks its caller first.
 *
 * The second argument is `{ unreceived, from }`. A number is still accepted
 * because a caller that only knows the open count has nothing else to add;
 * `from` is the scope waiting on the reply, so the steer can name it.
 */
export function stopNudge(mode, options = 0) {
	const opts =
		options && typeof options === "object"
			? options
			: { unreceived: Number(options) || 0 };
	const unreceived = Number.isInteger(opts.unreceived) ? opts.unreceived : 0;
	switch (mode) {
		case "AWAITING_REPLY":
			return render(T["mode.awaiting-reply"], {
				from: typeof opts.from === "string" && opts.from !== "" ? opts.from : "a peer scope",
			});
		case "CONTEXT_LIMIT":
			return T["mode.context-limit"];
		case "FINAL_ANSWER":
			return null;
		default:
			return unreceived > 0 ? insideScopeNudge(unreceived) : null;
	}
}
