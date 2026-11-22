/**
 * Herdchestra Lite 2.0 — omp extension entry.
 *
 * This root only sequences startup: capture host internals, wire the
 * extension, install the status surface. The tree below it is indexed by
 * domain: each directory's index.mjs lists its children's public keys.
 */

import { wireExtension, installCapture } from "./activation/index.mjs";
import { installStatus, loadPricingCatalog } from "./host/index.mjs";
import { total as diagnosticsTotal } from "./host/diagnostics.mjs";
import { preloadDocs } from "./prompts/index.mjs";
import { CHILD_ACTIVITY_TYPE, registerToolCardComponent, renderChildActivity } from "./host/child-display.mjs";

export async function activate(pi, env = process.env) {
	preloadDocs();
	// Broadcasts are custom messages; register before startup so transcript
	// replay and live streams use the same readable presentation.
	if (typeof pi.registerMessageRenderer === "function") {
		const render = (message) => {
			const Text = pi.pi?.Text;
			if (typeof Text !== "function") return undefined;
			const content = typeof message.content === "string"
				? message.content
				: (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
			return new Text(content, 1, 0);
		};
		pi.registerMessageRenderer("fission.broadcast", render);
		let ToolExecutionComponent;
		try {
			({ ToolExecutionComponent } = await import("@oh-my-pi/pi-tui/chat/tool-execution"));
			registerToolCardComponent(ToolExecutionComponent);
		} catch {
			// A host without the standalone card export can still use Markdown.
		}
		pi.registerMessageRenderer(CHILD_ACTIVITY_TYPE, (message, options, theme) =>
			renderChildActivity(pi.pi, message, options, theme, ToolExecutionComponent));
	}
	// Resolve the builtin at the extension entry so compiled omp can bind its
	// embedded module rather than resolving from a transitive helper.
	let builtinExecutor;
	try {
		const registry = await import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry");
		builtinExecutor = registry.executeBuiltinSlashCommand;
	} catch {
		// The standalone test environment has no omp module registry.
	}
	const diagnosis = await installCapture(pi, builtinExecutor);
	const pricingCatalog = await loadPricingCatalog();
	const wired = wireExtension(pi, pricingCatalog, diagnosis, env);
	installStatus(pi, {
		diagnostics: { total: diagnosticsTotal },
		ports: wired.ports,
	});
	// The composition result is the only handle on the live registry. Tests
	// and host tooling use it to reach a station without a process-wide
	// singleton.
	return wired;
}

export default activate;
