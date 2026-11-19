// Activation commands: bind user commands to the current session station.

export function wireCommands(pi, registry) {
	pi.registerCommand?.("herd", {
		description: "Toggle interactive decision framing; optional text is sent as one user message",
		handler: async (args, ctx) => registry.stationFor(ctx).onHerdCommand(args),
	});
}
