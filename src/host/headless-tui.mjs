/**
 * Headless InteractiveModeContext adapter for the system /handoff command.
 *
 * omp's builtin dispatcher prefers a command's TUI handler. `/handoff` is
 * `/compact handoff`: its TUI handler calls `ctx.handleCompactCommand(focus,
 * "handoff")` and returns immediately because handoff compaction is
 * background. This adapter records the single completion promise that handler
 * starts; `sendSlashPrompt` awaits it as the commit barrier before the relay
 * advances.
 *
 * The context is an explicit object, not a catch-all Proxy. A capability the
 * command actually needs must exist, or the command fails loudly. In
 * particular `runCommandInBackground` is absent, so the non-TUI `/compact`
 * path cannot mistake a stub for a dispatcher and silently drop the run.
 */

function recordOutput(outputs, kind, message, options) {
	const text = typeof message === "string" ? message : String(message ?? "");
	if (!text) return;
	outputs.push({ kind, text });
	options?.onOutput?.(kind, text);
}

async function handleModelSwitch(session, spec, options, record) {
	const command = typeof spec === "string" ? spec.trim() : String(spec ?? "").trim();
	const handler =
		typeof options?.onSwitchModel === "function"
			? options.onSwitchModel
			: typeof session?.onSwitchModel === "function"
				? session.onSwitchModel.bind(session)
				: typeof session?.setModel === "function"
					? (value) => session.setModel(value)
					: null;
	if (!handler) {
		record("warning", "Model switching is unavailable in headless mode.");
		return { handled: false, spec: command };
	}
	try {
		const result = await handler(command, { session, options });
		record(
			"status",
			typeof result?.message === "string" && result.message
				? result.message
				: `Model switch requested: ${command}`,
		);
		return { handled: true, spec: command, result };
	} catch (error) {
		const message = String(error?.message ?? error ?? "Model switch failed");
		record("error", message);
		return { handled: false, spec: command, error: message };
	}
}

async function handleSwitchSessionModel(session, model, thinkingLevel, options, record) {
	const label =
		model?.provider && model?.id
			? `${model.provider}/${model.id}`
			: String(model?.id ?? model ?? "model");
	try {
		if (typeof session?.setModelTemporary === "function") {
			const result = await session.setModelTemporary(model, thinkingLevel);
			record("status", `Session-only model: ${label}.`);
			return { handled: true, model, thinkingLevel, result };
		}
		if (typeof session?.setModel === "function") {
			const result = await session.setModel(model);
			if (thinkingLevel !== undefined && typeof session.setThinkingLevel === "function") {
				await session.setThinkingLevel(thinkingLevel);
			}
			record("status", `Session-only model: ${label}.`);
			return { handled: true, model, thinkingLevel, result };
		}
	} catch (error) {
		const message = String(error?.message ?? error ?? "Failed to switch model");
		record("error", message);
		return { handled: false, model, thinkingLevel, error: message };
	}
	record("error", "Session model switching is unavailable in headless mode.");
	return { handled: false, model, thinkingLevel, error: "unavailable" };
}

export function createHeadlessTuiContext(session, options = {}, command) {
	const outputs = [];
	let result;
	let completion;

	const runHandoff = (focus) => {
		if (completion) return completion;
		const run = () => {
			if (!session || typeof session.compact !== "function") {
				throw new Error(
					"The live session does not expose compact(); the system /handoff cannot run",
				);
			}
			return session.compact(focus, { mode: "handoff" });
		};
		const flow =
			typeof options.onSessionHandoff === "function"
				? Promise.resolve().then(() => options.onSessionHandoff(run, focus))
				: Promise.resolve().then(run);
		completion = flow.then((value) => {
			result = value;
			return value;
		});
		// The native background dispatcher does not await its UI handler; keep
		// an unhandled rejection from escaping while sendSlashPrompt still sees
		// the rejection through `completion`.
		void completion.catch(() => {});
		return completion;
	};

	const editor = {
		getText: () => "",
		setText: () => {},
		clear: () => {},
	};

	const ctx = {
		session,
		sessionManager: session?.sessionManager,
		settings: session?.settings,
		modelRegistry:
			options?.modelRegistry ?? session?.modelRegistry ?? options?.ctx?.modelRegistry,
		model: session?.model ?? session?.agent?.state?.model ?? options?.model ?? null,
		editor,
		ui: {
			requestRender: () => {},
			notify: (message, type = "info") => recordOutput(outputs, type, message, options),
		},
		collabGuest: false,
		showStatus: (message) => recordOutput(outputs, "status", message, options),
		showWarning: (message) => recordOutput(outputs, "warning", message, options),
		showError: (message) => recordOutput(outputs, "error", message, options),
		updatePendingMessagesDisplay: () => {},
		refreshSlashCommandState: async () => {},
		applySessionPin: () => {},
		handleCompactCommand: (focus, mode) => {
			if (command !== "handoff" || mode !== "handoff") {
				throw new Error(
					`Unsupported headless compaction: ${command ?? "?"} ${mode ?? ""}`.trim(),
				);
			}
			return runHandoff(focus);
		},
		onSwitchModel: (spec, switchOptions) =>
			handleModelSwitch(
				session,
				spec,
				{ ...options, ...switchOptions },
				(kind, message) => recordOutput(outputs, kind, message, options),
			),
		switchSessionModel: (model, thinkingLevel) =>
			handleSwitchSessionModel(
				session,
				model,
				thinkingLevel,
				options,
				(kind, message) => recordOutput(outputs, kind, message, options),
			),
	};

	return {
		ctx,
		outputs,
		get completion() {
			return completion;
		},
		get result() {
			return result;
		},
	};
}
