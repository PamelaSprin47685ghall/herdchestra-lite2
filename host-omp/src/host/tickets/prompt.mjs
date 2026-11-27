// Prompt delivery and the text shapes a host verb returns.

import { record } from "../diagnostics.mjs";

/** A plain text tool result. */
export const textResult = (text) => ({ content: [{ type: "text", text }] });

/**
 * The warning a model switch appends when the host cannot prove the switch
 * landed. The text lives with the host verb because only this package can
 * observe the post-switch model.
 */
export function modelSwitchWarning(vars = {}) {
	const command = vars.command ?? "model switch";
	const reason = vars.reason ?? "unverified";
	return `⚠ The ${command} could not be verified: ${reason}. The next request may still use the previous model.`;
}

/**
 * Fire-and-forget user-message delivery. A plain message without `deliverAs`
 * always starts one turn, which is what `/herd-goal <text>` promises.
 */
export async function sendUserMessageTicket(pi, text) {
	if (!text) return;
	try {
		await pi?.sendUserMessage?.(text, { attribution: "agent" });
	} catch (error) {
		// A host that rejects the message must not leak an unhandled rejection,
		// but `/herd-goal <text>` promises the user one turn: losing that message in
		// silence is the worst outcome, so it is recorded instead.
		record("tickets", error, { kind: "prompt", chars: text.length });
	}
}
