/**
 * Headless InteractiveModeContext adapter for system slash commands.
 *
 * The relay handoff does not use this path. It calls
 * `session.compact(focus, { mode: "handoff" })` directly: that is the same call
 * the builtin `/handoff` and the RPC `handoff` command make, and `focus` is the
 * command's only argument. No prompt, user message, or developer message is
 * sent.
 *
 * This adapter remains for `/switch` and `/model`, which must go through the
 * host's builtin slash executor. The context is an explicit object, not a
 * catch-all Proxy. A capability the command actually needs must exist, or the
 * command fails loudly.
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

export function createHeadlessTuiContext(session, options = {}) {
	const outputs = [];

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
		handleCompactCommand: () => {
			throw new Error(
				"Headless compaction is unavailable; relay handoff calls session.compact directly.",
			);
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

	return { ctx, outputs };
}
