// Dispatch the real system /handoff slash command.
//
// The successor and audit instructions are the command's only argument. No
// prompt, user message, or developer message is sent: the handoff document is
// what carries the instructions into the compacted transcript. The command
// promise resolves only after the background compaction commits, so its
// resolution is the relay barrier.

import { sendSlashPrompt } from "../host/capture.mjs";
import { handoffFocus } from "../relay/index.mjs";
import { callHandoffWithRecovery } from "./session.mjs";

function failureText(dispatched) {
	const output = dispatched?.outputs?.at(-1)?.text;
	return dispatched?.residual ?? output ?? "The system /handoff command did not complete";
}

export async function performHandoff(station, session) {
	if (!session) throw new Error("Cannot resolve the live AgentSession for /handoff");
	const focus = handoffFocus(station.state.relay);
	const dispatched = await sendSlashPrompt(session, `/handoff ${focus}`, {
		slashOnly: true,
		onSessionHandoff: (run) => callHandoffWithRecovery(session, run),
	});
	if (!dispatched.handled) throw new Error(failureText(dispatched));
	if (!station.advanceRelayForHandoff()) {
		throw new Error("handoff completed but relay did not advance");
	}
	return { ok: true };
}
