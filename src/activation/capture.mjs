/**
 * Host capture installation. Prefers the injected host namespace, then falls
 * back to a package import.
 */

import {
	installRunnerCapture,
	installBuiltinSlashExecutor,
} from "../host/capture.mjs";

export async function installCapture(pi, builtinExecutor) {
	installBuiltinSlashExecutor(builtinExecutor);
	let injected = null;
	try {
		injected = pi?.pi ?? null;
	} catch {
		// The injected namespace is optional.
	}
	if (typeof injected?.AgentSession === "function") {
		installRunnerCapture(injected.AgentSession);
	}
	try {
		const host = await import("@oh-my-pi/pi-coding-agent");
		if (host?.AgentSession) installRunnerCapture(host.AgentSession);
	} catch {
		// Optional. Scope enforcement uses only the public session manager.
	}
}
