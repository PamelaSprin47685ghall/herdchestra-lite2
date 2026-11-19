// Activation commands: bind user commands to the current session station.

export function wireCommands(pi, registry) {
	pi.registerCommand?.("herd", {
		description: "Toggle interactive decision framing",
		handler: async (_args, ctx) => registry.stationFor(ctx).onHerdCommand(),
	});
}
