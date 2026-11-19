// Dispatch the builtin command without submitting a conversation prompt.

import { sendSlashPrompt, tuiFor } from "../host/capture.mjs";
import { handoffFocus } from "../relay/index.mjs";
import { callHandoffWithRecovery } from "./session.mjs";
import { renderTui } from "./tui.mjs";

export async function performHandoff(station, session) {
	if (!session) throw new Error("Cannot resolve the live AgentSession for /handoff");
	const focus = handoffFocus(station.state.relay);
	const dispatched = await sendSlashPrompt(session, `/handoff ${focus}`, {
		slashOnly: true,
		onSessionHandoff: (run) => callHandoffWithRecovery(session, run),
	});
	if (!dispatched.handled || !dispatched.result || dispatched.result.ok === false) {
		throw new Error(dispatched.result?.error ?? dispatched.outputs.at(-1)?.text ??
			"The system /handoff command did not complete");
	}
	if (!station.advanceRelayForHandoff()) {
		throw new Error("handoff completed but relay did not advance");
	}
	await renderTui(tuiFor(session));
	return { ok: true };
}
