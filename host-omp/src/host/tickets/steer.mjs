// Steer delivery: the one ticket whose whole body is a host call.

import { record } from "../diagnostics.mjs";

/** Fire-and-forget steer delivery. The scope result already reports the send. */
export async function sendSteerTicket(pi, text) {
	if (!text) return;
	try {
		await pi?.sendUserMessage?.(text, { deliverAs: "steer", attribution: "agent" });
	} catch (error) {
		// Steer delivery stays best-effort: it never escapes as an unhandled
		// rejection. But a nudge the model never receives looks exactly like an
		// idle model, so the failure must leave a trace.
		record("tickets", error, { kind: "steer", chars: text.length });
	}
}
