// Activation hooks: bind each host event to its station gatekeeper.

export function wireHooks(pi, registry) {
	let assistantMessageRegistered = false;
	try {
		pi.on("assistant_message", (event, ctx) =>
			registry.stationFor(ctx).onAssistantMessage(event?.message, ctx),
		);
		assistantMessageRegistered = true;
	} catch {
		assistantMessageRegistered = false;
	}
	if (!assistantMessageRegistered) {
		try {
			pi.on("message_end", (event, ctx) =>
				registry.stationFor(ctx).onMessageEnd(event, ctx),
			);
		} catch {
			// Neither assistant_message nor message_end is available.
		}
	} else {
		// Some providers attach usage only at message_end. Record it with a
		// dedicated, safe listener even when assistant_message already drives
		// the scope transitions.
		try {
			pi.on("message_end", (event, ctx) =>
				registry.stationFor(ctx).onUsageMessage(event?.message, ctx),
			);
		} catch {
			// Usage at message_end is optional.
		}
	}
	pi.on("tool_call", (event, ctx) =>
		registry.stationFor(ctx).onToolCall(event, ctx),
	);
	pi.on("context", (event, ctx) =>
		registry.stationFor(ctx).onContext(event?.messages, ctx),
	);
	pi.on("before_agent_start", (event, ctx) =>
		registry.stationFor(ctx).onBeforeAgentStart(event, ctx),
	);
	pi.on("session_stop", (_event, ctx) =>
		registry.stationForStop(ctx).onSessionStop(ctx),
	);
	pi.on("session_switch", (event, ctx) =>
		registry.stationForStop(ctx).onSessionSwitch(event, ctx),
	);
	pi.on("session_compact", (_event, ctx) =>
		registry.stationFor(ctx).onSessionCompact(ctx),
	);
	pi.on("auto_compaction_end", (event, ctx) =>
		registry.stationForStop(ctx).onAutoCompactionEnd(event, ctx),
	);
}
