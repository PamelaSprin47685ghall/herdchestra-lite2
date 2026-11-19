/**
 * Host capture installation. Prefers the injected host namespace, then falls
 * back to a package import.
 */

import {
	installInteractiveCapture,
	installRunnerCapture,
	installBuiltinSlashExecutor,
	sendSlashPrompt,
	sessionFor,
} from "../host/capture.mjs";

export async function installCapture(pi, builtinExecutor, retainedTail) {
	installBuiltinSlashExecutor(builtinExecutor, retainedTail);
	let injected = null;
	try {
		injected = pi?.pi ?? null;
	} catch {
		// The injected namespace is optional.
	}
	if (typeof injected?.AgentSession === "function") {
		installRunnerCapture(injected.AgentSession, injected);
	}
	installInteractiveCapture(injected?.InteractiveMode);
	try {
		const host = await import("@oh-my-pi/pi-coding-agent");
		if (host?.AgentSession) installRunnerCapture(host.AgentSession, host);
		installInteractiveCapture(host?.InteractiveMode);
	} catch {
		// Optional. Scope enforcement uses only the public session manager.
	}
	if (pi && typeof pi === "object" && typeof pi.sendSlashPrompt !== "function") {
		try {
			Object.defineProperty(pi, "sendSlashPrompt", {
				value: (text, options = {}) => {
					const target =
						options?.session ??
						sessionFor(options?.ctx) ??
						(typeof options?.ctx === "object" ? options.ctx : null);
					if (target && typeof target.sendSlashPrompt === "function") {
						return target.sendSlashPrompt(text, options);
					}
					return sendSlashPrompt(target, text, {
						...options,
						fallbackSend:
							typeof pi.sendUserMessage === "function"
								? (t, o) => pi.sendUserMessage(t, o)
								: undefined,
					});
				},
				configurable: true,
				writable: true,
			});
		} catch {
			// A frozen pi host object simply uses sendSlashPrompt directly.
		}
	}
}
