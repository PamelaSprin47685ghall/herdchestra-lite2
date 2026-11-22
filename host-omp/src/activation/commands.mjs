// Activation commands: bind user commands to the current session station.

import { snapshot } from "../host/diagnostics.mjs";
import { providerDiagnostics } from "../host/provider-observer.mjs";


/** Render evidence on one line: compact JSON, or the value itself. */
function compactDetail(detail) {
	if (detail === undefined) return "";
	try {
		return ` ${JSON.stringify(detail)}`;
	} catch {
		return ` ${String(detail)}`;
	}
}

export function wireCommands(pi, engine) {
	// A wiring may hand a full engine or a station-shaped double.
	const stationOf = (ctx) => (engine.station ?? engine.stationFor)(ctx);
	const stationForStop = (ctx) => (engine.stationForStop ?? engine.stationFor)(ctx);
	pi.registerCommand?.("herd-autopilot", {
		description: "Toggle autopilot: off is manual duty with ask; on is the fully automatic relay",
		handler: async (args, ctx) => stationOf(ctx).onAutopilotCommand(args),
	});
	pi.registerCommand?.("herd-diag", {
		description: "Print the last host diagnostics",
		handler: async (_args, ctx) => {
			const entries = snapshot();
			const reports = providerDiagnostics(stationOf(ctx));
			if (entries.length === 0 && reports.length === 0) {
				ctx?.ui?.notify?.("Herdchestra: no diagnostics recorded.", "info");
				return "Herdchestra: no diagnostics recorded.";
			}
			const lines = entries.map(
				(entry) => {
					const repeat = entry.count > 1 ? ` ×${entry.count}` : "";
					return `${new Date(entry.t).toISOString()} [${entry.domain}] ${entry.message}${repeat}${compactDetail(entry.detail)}`;
				},
			);
			for (const report of reports) {
				lines.push(`[provider latest]${compactDetail(report)}`);
			}
			const text = lines.join("\n");
			ctx?.ui?.notify?.(text, "info");
			return text;
		},
	});
}
