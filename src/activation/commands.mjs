// Activation commands: bind user commands to the current session station.

import { snapshot } from "../host/diagnostics.mjs";

export function wireCommands(pi, registry) {
	pi.registerCommand?.("herd", {
		description: "Toggle interactive decision framing; optional text is sent as one user message",
		handler: async (args, ctx) => registry.stationFor(ctx).onHerdCommand(args),
	});
	pi.registerCommand?.("herd-diag", {
		description: "Print the last host diagnostics",
		handler: async (_args, ctx) => {
			const entries = snapshot();
			if (entries.length === 0) {
				ctx?.ui?.notify?.("Herdchestra: no diagnostics recorded.", "info");
				return "Herdchestra: no diagnostics recorded.";
			}
			const lines = entries.map(
				(entry) => {
					const repeat = entry.count > 1 ? ` ×${entry.count}` : "";
					return `${new Date(entry.t).toISOString()} [${entry.domain}] ${entry.message}${repeat}`;
				},
			);
			const text = lines.join("\n");
			ctx?.ui?.notify?.(text, "info");
			return text;
		},
	});
}
