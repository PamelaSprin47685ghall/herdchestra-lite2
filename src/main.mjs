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

export async function activate(pi, env = process.env) {
	preloadDocs();
	// Broadcasts are custom messages; register before startup so transcript
	// replay and live streams use the same readable presentation.
	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer("fission.broadcast", (message) => {
			const Text = pi.pi?.Text;
			if (typeof Text !== "function") return undefined;
			const content = typeof message.content === "string"
				? message.content
				: (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
			return new Text(content, 1, 0);
		});
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
	wireExtension(pi, pricingCatalog, diagnosis, env);
	installStatus(pi, { diagnostics: { total: diagnosticsTotal } });
}

export default activate;
