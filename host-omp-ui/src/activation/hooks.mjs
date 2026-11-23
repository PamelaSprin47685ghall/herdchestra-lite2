// Mechanical event forwarding. Each handler is isolated: omp extensions have no
// isolation, so a throw here would teardown the whole session. No business
// branching lives in this file.
function availableThinkingLevels(ctx) {
	try {
		const levels = ctx?.session?.getAvailableEffortSelectors?.();
		if (Array.isArray(levels) && levels.length > 0) {
			return levels.filter((level) => typeof level === "string");
		}
		// Empty is authoritative only when the current model explicitly declares
		// reasoning: false. Otherwise leave thinkingLevels untouched so the
		// adapter's hydrated multi-level list keeps the slider.
		const model = ctx?.models?.current?.();
		if (model && typeof model === "object" && model.reasoning === false) return [];
		return undefined;
	} catch {
		return undefined;
	}
}

function modelPatch(event, ctx) {
	const patch = { model: event?.model ?? event };
	const levels = availableThinkingLevels(ctx);
	if (levels !== undefined) patch.thinkingLevels = levels;
	return patch;
}

const EVENT_MAP = {
	before_agent_start: (event, ctx, station) => station.onBeforeAgentStart?.(event, ctx),
	agent_start: (event, _ctx, station) => station.onAgentEvent?.(event),
	agent_end: (event, _ctx, station) => station.onAgentEvent?.(event),
	message_start: (event, _ctx, station) => station.onAgentEvent?.(event),
	message_update: (event, _ctx, station) => station.onAgentEvent?.(event),
	message_end: (event, _ctx, station) => station.onAgentEvent?.(event),
	tool_execution_start: (event, _ctx, station) => station.onAgentEvent?.(event),
	tool_execution_update: (event, _ctx, station) => station.onAgentEvent?.(event),
	tool_execution_end: (event, _ctx, station) => station.onAgentEvent?.(event),
	queue_update: (event, _ctx, station) => station.onQueueUpdate?.(event),
	todo_reminder: (event, _ctx, station) => station.onTodoUpdate?.(event?.todos ?? event),
	todo_auto_clear: (_event, _ctx, station) => station.onTodoUpdate?.([]),
	model_change: (event, ctx, station) => station.onMetaUpdate?.(modelPatch(event, ctx)),
	model_changed: (event, ctx, station) => station.onMetaUpdate?.(modelPatch(event, ctx)),
	model_select: (event, ctx, station) => station.onMetaUpdate?.(modelPatch(event, ctx)),
	thinking_level_change: (event, ctx, station) =>
		station.onMetaUpdate?.({
			thinkingLevel: event?.level ?? event?.thinkingLevel,
			...(availableThinkingLevels(ctx) !== undefined
				? { thinkingLevels: availableThinkingLevels(ctx) }
				: {}),
		}),
	thinking_level_changed: (event, ctx, station) =>
		station.onMetaUpdate?.({
			thinkingLevel: event?.level ?? event?.thinkingLevel,
			...(availableThinkingLevels(ctx) !== undefined
				? { thinkingLevels: availableThinkingLevels(ctx) }
				: {}),
		}),
	mode_changed: (event, _ctx, station) => station.onMetaUpdate?.({ modes: event?.state ?? event }),
	notice: (event, _ctx, station) => station.onNotify?.(event?.message ?? event, event?.level ?? "info"),
	plan_review_requested: (event, _ctx, station) => station.onPlanReviewRequested?.(event),
	plan_review_resolved: (event, _ctx, station) => station.onPlanReviewResolved?.(event),
	session_switch: (event, ctx, station) => station.onSessionSwitch?.(ctx, event),
	session_clear: (event, ctx, station) => station.onSessionClear?.(ctx, event),
	session_branch: (event, ctx, station) => station.onSessionBranch?.(ctx, event),
};

export function wireHooks({ pi, getStation, diagnostics, onSessionStart, onSessionShutdown, onSessionChange } = {}) {
	const guard = (event, handler) => async (...args) => {
		try {
			return await handler(...args);
		} catch (error) {
			diagnostics?.record?.(`hook:${event}`, error);
			return undefined;
		}
	};

	pi.on("session_start", guard("session_start", onSessionStart));
	pi.on("session_shutdown", guard("session_shutdown", onSessionShutdown));

	for (const [event, forward] of Object.entries(EVENT_MAP)) {
		pi.on(
			event,
			guard(event, (payload, ctx) => {
				const station = getStation?.();
				if (!station) return undefined;
				const result = forward(payload, ctx, station);
				if (event === "session_switch" || event === "session_branch") onSessionChange?.(ctx);
				return result;
			}),
		);
	}
}
