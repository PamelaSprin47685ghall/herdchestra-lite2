/**
 * Headless TUI Adapter (Route 2) for running `handleTui` builtin slash commands
 * outside InteractiveMode (RPC, Print, tests, or programmatic `sendSlashPrompt`).
 *
 * Follows AGENTS.md Ticket Station Method:
 * - `HeadlessTuiStation` holds per-session headless UI/mode state with strictly
 *   synchronous methods (no `async`/`await`).
 * - Async command flows live in standalone ticket functions.
 * - `createHeadlessTuiContext` wires a Proxy-backed `InteractiveModeContext`
 *   compatible object that captures UI feedback and delegates supported
 *   commands to public `AgentSession` / `SessionManager` APIs.
 */

const HEADLESS_STATE_KEY = Symbol.for("herdchestra-lite2.headless-tui.v1");

function stateStore() {
	let store = globalThis[HEADLESS_STATE_KEY];
	if (!store) {
		store = new WeakMap();
		Object.defineProperty(globalThis, HEADLESS_STATE_KEY, {
			value: store,
			enumerable: false,
			configurable: true,
		});
	}
	return store;
}

/**
 * Pure synchronous state station for one headless session.
 */
export class HeadlessTuiStation {
	constructor() {
		this.vibeModeEnabled = false;
		this.vibeModePreviousTools = undefined;
		this.vibeModeOwnerScope = undefined;
		this.vibeModeEntry = undefined;
		this.planModeEnabled = false;
		this.planModePaused = false;
		this.goalModeEnabled = false;
		this.goalModePaused = false;
	}

	beginVibeEntry(promise) {
		this.vibeModeEntry = promise;
	}

	endVibeEntry(promise) {
		if (this.vibeModeEntry === promise) {
			this.vibeModeEntry = undefined;
		}
	}

	enterVibeState(previousTools, ownerScope) {
		this.vibeModePreviousTools = previousTools;
		this.vibeModeOwnerScope = ownerScope;
		this.vibeModeEnabled = true;
	}

	exitVibeState() {
		const previousTools = this.vibeModePreviousTools ?? [];
		const ownerScope = this.vibeModeOwnerScope;
		this.vibeModeEnabled = false;
		this.vibeModePreviousTools = undefined;
		this.vibeModeOwnerScope = undefined;
		return { previousTools, ownerScope };
	}
}

export function headlessStationFor(session) {
	if (!session || typeof session !== "object") {
		return new HeadlessTuiStation();
	}
	const store = stateStore();
	let station = store.get(session);
	if (!station) {
		station = new HeadlessTuiStation();
		store.set(session, station);
	}
	return station;
}

async function resolveVibeRegistry() {
	try {
		const mod = await import("@oh-my-pi/pi-coding-agent/tools/vibe-session-registry");
		if (mod?.VibeSessionRegistry?.global) {
			return mod.VibeSessionRegistry.global();
		}
	} catch {
		// Optional when running outside full host package.
	}
	return null;
}

async function handleHandoffTicket(run, focus, options, invocation) {
	const result = typeof options.onSessionHandoff === "function"
		? await options.onSessionHandoff(run, focus)
		: await run();
	invocation.setResult(result);
	if (result && result.ok !== false && !result.inProgress) {
		invocation.recordOutput("status", "Context handed off and compacted in place.");
	}
	return result;
}

async function enterVibeModeTicket(session, station, invocation) {
	if (station.vibeModeEnabled) return;
	if (station.vibeModeEntry) {
		await station.vibeModeEntry;
		return;
	}
	if (station.planModeEnabled || station.planModePaused) {
		station.recordOutput("warning", "Exit plan mode first.");
		return;
	}
	if (station.goalModeEnabled || station.goalModePaused) {
		station.recordOutput("warning", "Exit goal mode first.");
		return;
	}

	const vibeRegistry = await resolveVibeRegistry();
	const ownerScope = vibeRegistry?.ownerScope?.(session);
	vibeRegistry?.activateScope?.(ownerScope);

	const previousTools =
		typeof session?.getEnabledToolNames === "function"
			? session.getEnabledToolNames()
			: [];
	const vibeBaseTools = ["read"];
	if (typeof session?.hasBuiltInTool === "function" && session.hasBuiltInTool("todo")) {
		vibeBaseTools.push("todo");
	}

	const entry = (async () => {
		if (typeof session?.activateVibeTools === "function") {
			await session.activateVibeTools(vibeBaseTools);
		}
		station.enterVibeState(previousTools, ownerScope);
		if (typeof session?.setVibeModeState === "function") {
			session.setVibeModeState({ enabled: true });
		}
		if (session?.isStreaming && typeof session?.sendVibeModeContext === "function") {
			await session.sendVibeModeContext({ deliverAs: "steer" });
		}
		if (typeof session?.sessionManager?.appendModeChange === "function") {
			session.sessionManager.appendModeChange("vibe", { previousTools });
		}
		invocation.recordOutput(
			"status",
			"Vibe mode enabled. You direct fast/good worker sessions; toolset is read + optional parent Todo + vibe tools.",
		);
	})();

	station.beginVibeEntry(entry);
	try {
		await entry;
	} finally {
		station.endVibeEntry(entry);
	}
}

async function exitVibeModeTicket(session, station, invocation) {
	if (!station.vibeModeEnabled) return;
	const { previousTools, ownerScope } = station.exitVibeState();
	let killed = 0;
	const runTeardown = async () => {
		if (session?.isStreaming && typeof session?.abort === "function") {
			await session.abort();
		}
		const vibeRegistry = await resolveVibeRegistry();
		if (vibeRegistry && typeof vibeRegistry.killAll === "function") {
			killed = await vibeRegistry.killAll(session, ownerScope);
		}
		if (typeof session?.deactivateVibeTools === "function") {
			await session.deactivateVibeTools(previousTools);
		}
		if (typeof session?.setVibeModeState === "function") {
			session.setVibeModeState(undefined);
		}
	};
	if (typeof session?.runModeExitTeardown === "function") {
		await session.runModeExitTeardown(runTeardown);
	} else {
		await runTeardown();
	}
	invocation.recordOutput(
		"status",
		killed > 0
			? `Vibe mode disabled. Killed ${killed} worker session${killed === 1 ? "" : "s"}.`
			: "Vibe mode disabled.",
	);
}

async function handleVibeModeTicket(session, prompt, options, station, invocation) {
	const trimmed = typeof prompt === "string" ? prompt.trim() : "";
	if (trimmed) {
		await enterVibeModeTicket(session, station, invocation);
		if (station.vibeModeEnabled && typeof session?.prompt === "function") {
			const res = await session.prompt(trimmed, options);
			invocation.setResult(res);
			return res;
		}
		return;
	}
	if (station.vibeModeEnabled) {
		await exitVibeModeTicket(session, station, invocation);
	} else {
		await enterVibeModeTicket(session, station, invocation);
	}
}

async function handleNewTicket(session, station) {
	if (typeof session?.newSession === "function") {
		const ok = await session.newSession();
		station.setResult({ newSession: ok });
		station.recordOutput("status", ok ? "Started a new session." : "New session cancelled.");
		return ok;
	}
	station.recordOutput("warning", "Session does not support newSession() in headless mode.");
	return false;
}

async function handleFreshTicket(session, station) {
	if (typeof session?.freshSession === "function") {
		const result = session.freshSession();
		station.setResult(result);
		station.recordOutput(
			"status",
			result ? "Provider stream state refreshed." : "Fresh session unavailable while streaming.",
		);
		return result;
	}
	station.recordOutput("warning", "Session does not support freshSession().");
	return null;
}

function createEditorStub() {
	let text = "";
	return {
		getText: () => text,
		setText: (next) => {
			text = typeof next === "string" ? next : "";
		},
		clear: () => {
			text = "";
		},
	};
}

async function handleModelSwitch(session, spec, options, station) {
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
		station.recordOutput(
			"warning",
			"Model switching is unavailable in headless mode.",
		);
		return { handled: false, spec: command };
	}
	try {
		const result = await handler(command, { session, options });
		station.setResult(result);
		station.recordOutput(
			"status",
			typeof result?.message === "string" && result.message
				? result.message
				: `Model switch requested: ${command}`,
		);
		return { handled: true, spec: command, result };
	} catch (error) {
		const message = String(error?.message ?? error ?? "Model switch failed");
		station.recordOutput("error", message);
		return { handled: false, spec: command, error: message };
	}
}

async function handleSwitchSessionModel(
	session,
	model,
	thinkingLevel,
	options,
	station,
) {
	const label =
		model?.provider && model?.id
			? `${model.provider}/${model.id}`
			: String(model?.id ?? model ?? "model");
	const notifyError = (message) => {
		station.recordOutput("error", message);
		options?.onOutput?.("error", message);
	};
	if (typeof session?.setModelTemporary === "function") {
		try {
			const result = await session.setModelTemporary(model, thinkingLevel);
			station.setResult(result);
			station.recordOutput("status", `Session-only model: ${label}.`);
			return { handled: true, model, thinkingLevel, result };
		} catch (error) {
			const message = String(error?.message ?? error ?? "Failed to switch model");
			notifyError(message);
			return { handled: false, model, thinkingLevel, error: message };
		}
	}
	if (typeof session?.setModel === "function") {
		try {
			const result = await session.setModel(model);
			if (
				thinkingLevel !== undefined &&
				typeof session.setThinkingLevel === "function"
			) {
				await session.setThinkingLevel(thinkingLevel);
			}
			station.setResult(result);
			station.recordOutput("status", `Session-only model: ${label}.`);
			return { handled: true, model, thinkingLevel, result };
		} catch (error) {
			const message = String(error?.message ?? error ?? "Failed to switch model");
			notifyError(message);
			return { handled: false, model, thinkingLevel, error: message };
		}
	}
	notifyError("Session model switching is unavailable in headless mode.");
	return {
		handled: false,
		model,
		thinkingLevel,
		error: "Session model switching is unavailable in headless mode.",
	};
}

/**
 * Build a headless `InteractiveModeContext`-compatible adapter for a session.
 */
export function createHeadlessTuiContext(session, options = {}, command) {
	const station = headlessStationFor(session);
	const outputs = [];
	let result;
	let completion;
	const invocation = {
		recordOutput(kind, message) {
			const text = typeof message === "string" ? message : String(message ?? "");
			if (text) outputs.push({ kind, text });
		},
		setResult(value) {
			result = value;
		},
	};
	const handoff = (run, focus) => {
		if (!completion) {
			completion = handleHandoffTicket(run, focus, options, invocation);
			// The native background dispatcher may not await its UI handler.
			void completion.catch(() => {});
		}
		return completion;
	};

	const editor = createEditorStub();
	const uiStub = new Proxy(
		{
			requestRender: () => {},
			notify: (msg, type = "info") => invocation.recordOutput(type, msg),
		},
		{
			get(target, prop) {
				if (prop in target) return target[prop];
				if (typeof prop === "symbol") return undefined;
				return () => {};
			},
		},
	);

	const explicit = {
		session,
		sessionManager: session?.sessionManager,
		settings: session?.settings,
		get modelRegistry() {
			return options?.modelRegistry ?? session?.modelRegistry ?? options?.ctx?.modelRegistry;
		},
		get model() {
			return (
				session?.model ??
				session?.agent?.state?.model ??
				options?.model ??
				null
			);
		},
		editor,
		ui: uiStub,
		collabGuest: false,
		get vibeModeEnabled() {
			return station.vibeModeEnabled;
		},
		set vibeModeEnabled(value) {
			station.vibeModeEnabled = Boolean(value);
		},
		get planModeEnabled() {
			return Boolean(session?.getPlanModeState?.()?.enabled ?? station.planModeEnabled);
		},
		get planModePaused() {
			return station.planModePaused;
		},
		get goalModeEnabled() {
			return Boolean(session?.getGoalModeState?.()?.enabled ?? station.goalModeEnabled);
		},
		get goalModePaused() {
			return station.goalModePaused;
		},
		showStatus: (message) => {
			invocation.recordOutput("status", message);
			options?.onOutput?.("status", message);
		},
		showWarning: (message) => {
			invocation.recordOutput("warning", message);
			options?.onOutput?.("warning", message);
		},
		showError: (message) => {
			invocation.recordOutput("error", message);
			options?.onOutput?.("error", message);
		},
		renderInitialMessages: async () => {},
		refreshSlashCommandState: async () => {},
		applySessionPin: () => {},
		updatePendingMessagesDisplay: () => {},
		stopLoading: () => {},
		handleHandoffCommand: (focus) => handoff(() => {
			if (typeof session?.handoff !== "function") {
				throw new Error("Cannot dispatch system /handoff: native slash registry is unavailable");
			}
			return session.handoff(focus);
		}, focus),
		// Omp also registers /handoff as a /compact alias. At the model boundary
		// run its in-place handoff, not the interactive abort/continue pipeline.
		handleCompactCommand: (focus, mode) => {
			if (command === "handoff" && mode === "handoff") {
				return handoff(() => session.compact(focus, { mode }), focus);
			}
		},
		handleVibeModeCommand: (prompt) =>
			handleVibeModeTicket(session, prompt, options, station, invocation),
		handleNewCommand: () => handleNewTicket(session, invocation),
		handleFreshCommand: () => handleFreshTicket(session, invocation),
		onSwitchModel: (spec, switchOptions) =>
			handleModelSwitch(
				session,
				spec,
				{ ...options, ...switchOptions },
				invocation,
			),
		switchSessionModel: (model, thinkingLevel) =>
			handleSwitchSessionModel(session, model, thinkingLevel, options, invocation),
	};

	const ctx = new Proxy(explicit, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			if (typeof prop === "symbol") return undefined;
			// Any unimplemented interactive-only handler/selector returns a safe stub.
			return (..._args) => {
				if (typeof prop === "string" && prop.startsWith("show")) {
					invocation.recordOutput("warning", `Interactive UI required for ${prop}.`);
				}
				return undefined;
			};
		},
		set(target, prop, value, receiver) {
			return Reflect.set(target, prop, value, receiver);
		},
	});

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

/**
 * Fallback builtin dispatcher used when `@oh-my-pi/pi-coding-agent` builtin
 * registry is unavailable (e.g., isolated unit tests).
 */
export async function executeFallbackBuiltinSlashCommand(parsed, headlessCtx) {
	if (!parsed) return false;
	switch (parsed.name) {
		case "handoff":
			await headlessCtx.handleHandoffCommand(parsed.args || undefined);
			return true;
		case "vibe":
			await headlessCtx.handleVibeModeCommand(parsed.args || undefined);
			return true;
		case "new":
			await headlessCtx.handleNewCommand();
			return true;
		case "fresh":
			await headlessCtx.handleFreshCommand();
			return true;
		case "model":
		case "switch":
			if (typeof headlessCtx.onSwitchModel === "function") {
				await headlessCtx.onSwitchModel(parsed.args || "");
				return true;
			}
			return false;
		default:
			return false;
	}
}
