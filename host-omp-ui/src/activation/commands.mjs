// The user-facing command. It reports the live web surface or the exact
// reason the surface is unavailable; it never starts or stops anything.
export function wireCommands({ pi, getStatus } = {}) {
	pi.registerCommand("web", {
		description: "Show the local DeerFlow Web UI URL",
		handler: async (_args, ctx) => {
			const status = getStatus?.() ?? { url: null, reason: "the web surface is not running" };
			const message = status.url
				? `DeerFlow Web: ${status.url}`
				: `DeerFlow Web is not available yet: ${status.reason ?? "session is not a TUI main session"}`;
			try {
				ctx?.ui?.notify?.(message, status.url ? "info" : "warning");
			} catch {
				// The command must stay safe even on a broken UI context.
			}
		},
	});
}
