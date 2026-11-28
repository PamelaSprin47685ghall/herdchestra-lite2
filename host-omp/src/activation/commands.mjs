// Activation commands: bind user commands to the current session station.
//
// Most handlers are plain functions: their station call returns synchronously.
// `/herd-goal` is the one exception — it awaits the host's official `/goal`
// transition before it reports, so the host sees a pending command exactly when
// one is pending. One handler also prints; it asks the diagnostics ring to
// render, because the ring owns both the records and their fields.

import { formatDiagnostics, snapshot } from "../host/diagnostics.mjs";
import { providerDiagnostics } from "../host/provider-observer.mjs";

export function wireCommands(pi, engine) {
  	// `engine.station` is the one entry the core exposes; one spelling, one answer.
  	const stationOf = (ctx) => engine.station(ctx);
	const notify = (ctx, result) => {
		if (typeof result?.message === "string") {
			ctx?.ui?.notify?.(result.message, result.ok === false ? "error" : "info");
		}
		return result;
	};
	pi.registerCommand?.("herd", {
		description: "Feature switches: /herd [feature [state [text...]]]",
		handler: (args, ctx) => notify(ctx, stationOf(ctx).onHerdCommand(args)),
	});
	pi.registerCommand?.("herd-goal", {
		description:
			"Start one goal session: /herd-goal <instruction> (alias for the official /goal; works in TUI, RPC, print, and headless. Bare /herd-goal turns goal mode off)",
		handler: async (args, ctx) =>
			notify(ctx, await stationOf(ctx).onGoalCommand(args, ctx)),
	});
	pi.registerCommand?.("herd-diag", {
		description: "Print the last host diagnostics",
		handler: (_args, ctx) => {
			const entries = snapshot();
			const reports = providerDiagnostics(stationOf(ctx));
			if (entries.length === 0 && reports.length === 0) {
				const none = "Herdchestra: no diagnostics recorded.";
				ctx?.ui?.notify?.(none, "info");
				return none;
			}
			const text = formatDiagnostics(entries, reports);
			ctx?.ui?.notify?.(text, "info");
			return text;
		},
	});
}
