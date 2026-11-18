/**
 * Herdchestra Lite 2.0 — omp extension entry.
 *
 * Keeps the retained English repo-aware prompt and the vibe-mode rewrite.
 * Scope mechanics are explained only by the three tool contracts.
 */

import {
	deferParameters,
	regretParameters,
	SCOPE_DESCRIPTION,
	scopeParameters,
	DEFER_DESCRIPTION,
	REGRET_DESCRIPTION,
} from "./descriptions.mjs";
import { installRunnerCapture } from "./runner-capture.mjs";
import {
	createDeferExecute,
	createRegretExecute,
	createScopeExecute,
	installHooks,
	installSystemPrompt,
} from "./runtime.mjs";

async function installCapture() {
	try {
		const host = await import("@oh-my-pi/pi-coding-agent");
		if (host?.AgentSession) installRunnerCapture(host.AgentSession);
	} catch {
		// Optional. Scope enforcement uses only the public session manager.
	}
}

function registerTools(pi) {
	pi.registerTool({
		name: "scope",
		label: "Scope",
		description: SCOPE_DESCRIPTION,
		parameters: scopeParameters,
		executionMode: "sequential",
		alwaysAvailable: true,
		execute: createScopeExecute(pi),
	});
	pi.registerTool({
		name: "regret",
		label: "Regret",
		description: REGRET_DESCRIPTION,
		parameters: regretParameters,
		executionMode: "sequential",
		alwaysAvailable: true,
		execute: createRegretExecute(pi),
	});
	pi.registerTool({
		name: "defer",
		label: "Defer",
		description: DEFER_DESCRIPTION,
		parameters: deferParameters,
		executionMode: "sequential",
		alwaysAvailable: true,
		execute: createDeferExecute(pi),
	});
}

export async function activate(pi) {
	await installCapture();
	installHooks(pi);
	installSystemPrompt(pi);
	registerTools(pi);
}

export default activate;
