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
	PIN_DESCRIPTION,
	pinParameters,
} from "./descriptions.mjs";
import {
	installInteractiveCapture,
	installRunnerCapture,
} from "./runner-capture.mjs";
import {
	createTodoExecute,
	TODO_DESCRIPTION,
	TODO_PARAMETERS,
} from "./todo.mjs";
import {
	createDeferExecute,
	createPinExecute,
	createRegretExecute,
	createScopeExecute,
	installHooks,
	installSystemPrompt,
} from "./runtime.mjs";
import { installStatus } from "./status.mjs";

async function installCapture(pi) {
	// The running omp binary may bundle a different class than the package's
	// source export. The ExtensionAPI injects the host's own module namespace,
	// so prefer that exact AgentSession and InteractiveMode before falling back
	// to a package import. InteractiveMode capture is what lets the stop hook
	// run the built-in /handoff command and rebuild the TUI transcript.
	let injected = null;
	try {
		injected = pi?.pi ?? null;
	} catch {
		// The injected namespace is optional.
	}
	if (typeof injected?.AgentSession === "function") {
		installRunnerCapture(injected.AgentSession);
	}
	installInteractiveCapture(injected?.InteractiveMode);
	try {
		const host = await import("@oh-my-pi/pi-coding-agent");
		if (host?.AgentSession) installRunnerCapture(host.AgentSession);
		installInteractiveCapture(host?.InteractiveMode);
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
		execute: createScopeExecute(pi),
	});
	pi.registerTool({
		name: "regret",
		label: "Regret",
		description: REGRET_DESCRIPTION,
		parameters: regretParameters,
		executionMode: "sequential",
		execute: createRegretExecute(pi),
	});
	pi.registerTool({
		name: "defer",
		label: "Defer",
		description: DEFER_DESCRIPTION,
		parameters: deferParameters,
		executionMode: "sequential",
		execute: createDeferExecute(pi),
	});
	pi.registerTool({
		name: "pin",
		label: "Pin",
		description: PIN_DESCRIPTION,
		parameters: pinParameters,
		executionMode: "sequential",
		execute: createPinExecute(pi),
	});
	// The extension writes this name after the host registered its own todo,
	// so the host map keeps this override. `execute` delegates to the native
	// tool through ctx.invokeTool and never keeps a second ledger.
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: TODO_DESCRIPTION,
		parameters: TODO_PARAMETERS,
		executionMode: "sequential",
		concurrency: "exclusive",
		strict: true,
		lenientArgValidation: true,
		loadMode: "essential",
		approval: "read",
		execute: createTodoExecute(pi),
	});
}

export async function activate(pi) {
	await installCapture(pi);
	installHooks(pi);
	installStatus(pi);
	installSystemPrompt(pi);
	registerTools(pi);
}

export default activate;
