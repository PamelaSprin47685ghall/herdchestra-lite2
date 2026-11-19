/**
 * Host capture & slash-capable sendPrompt monkey-patches for omp.
 *
 * Patches are idempotent, descriptor-safe, and scoped by SessionManager /
 * AgentSession instance via WeakMaps so multiple concurrent sessions never
 * collide. Works across TUI (InteractiveMode), RPC, and Print modes.
 */

import {
	createHeadlessTuiContext,
	executeFallbackBuiltinSlashCommand,
} from "./headless-tui.mjs";

const STATE_KEY = Symbol.for("herdchestra-lite2.session-capture.v1");
const VIBE_PATCH = Symbol.for("herdchestra-lite2.vibe-tools.v1");
const PROMPT_PATCH = Symbol.for("herdchestra-lite2.prompt-capture.v1");
const SLASH_PROMPT_PATCH = Symbol.for("herdchestra-lite2.slash-prompt.v1");
const INTERACTIVE_PATCH = Symbol.for("herdchestra-lite2.tui-capture.v1");
const SCOPE_TOOLS = ["scope", "regret", "defer", "pin", "todo"];

function patchMethod(prototype, name, marker, createWrapper) {
	if (!prototype || Object.hasOwn(prototype, marker)) return false;
	const original = prototype[name];
	if (typeof original !== "function") return false;
	Object.defineProperty(prototype, marker, { value: true });
	const wrapped = createWrapper(original);
	Object.defineProperty(prototype, name, {
		value: wrapped,
		writable: true,
		configurable: true,
	});
	return true;
}

function patchGetter(prototype, name, marker, createGetter) {
	if (!prototype || Object.hasOwn(prototype, marker)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
	if (!descriptor || typeof descriptor.get !== "function") return false;
	Object.defineProperty(prototype, marker, { value: true });
	Object.defineProperty(prototype, name, {
		...descriptor,
		get: createGetter(descriptor.get),
	});
	return true;
}

function state() {
	const existing = globalThis[STATE_KEY];
	if (existing) return existing;
	const created = {
		installed: false,
		error: null,
		prototype: null,
		descriptor: null,
		sessions: new WeakMap(),
		tuiBySession: new WeakMap(),
		tui: null,
		tuiRenders: 0,
		interactiveInstalled: false,
		interactiveError: null,
		slashPromptInstalled: false,
	};
	Object.defineProperty(globalThis, STATE_KEY, {
		value: created,
		enumerable: false,
		configurable: true,
	});
	return created;
}

function remember(session) {
	if (!session) return;
	const captured = state();
	captured.sessions.set(session, session);
	try {
		const manager = session.sessionManager;
		if (manager) captured.sessions.set(manager, session);
	} catch {
		// A throwing host getter is not a usable capture point.
	}
}

/** Test and host seam: bind a live AgentSession to its session manager. */
export function rememberSession(session) {
	remember(session);
}

/** The live AgentSession bound to this extension context or session, or null. */
export function sessionFor(context) {
	if (!context || typeof context !== "object") return null;
	const captured = state().sessions;
	try {
		const manager = context.sessionManager;
		if (manager) {
			const byManager = captured.get(manager);
			if (byManager) return byManager;
		}
	} catch {
		// Fall through to the context object itself.
	}
	return captured.get(context) ?? null;
}

/** The captured session's handoff method, or null. */
export function handoffFor(context) {
	const session = sessionFor(context);
	if (!session) return null;
	try {
		return typeof session.handoff === "function"
			? session.handoff.bind(session)
			: null;
	} catch {
		return null;
	}
}

/** Test and host seam: bind the live InteractiveMode instance (and its session). */
export function rememberTui(tui) {
	const captured = state();
	captured.tui = tui ?? null;
	if (!tui || typeof tui !== "object") return;
	try {
		const session = tui.session;
		if (session && typeof session === "object") {
			remember(session);
			captured.tuiBySession.set(session, tui);
		}
	} catch {
		// A mock TUI without a session getter still binds as the fallback TUI.
	}
}

/** The live InteractiveMode instance for the given session/context, or the main TUI. */
export function tuiFor(contextOrSession) {
	const captured = state();
	if (contextOrSession && typeof contextOrSession === "object") {
		const session = sessionFor(contextOrSession) ?? contextOrSession;
		const bySession = captured.tuiBySession.get(session);
		if (bySession) return bySession;
	}
	return captured.tui ?? null;
}

/** Capture instrumentation for logs. */
export function interactiveCaptureState() {
	const captured = state();
	return {
		installed: captured.interactiveInstalled,
		error: captured.interactiveError,
		hasTui: Boolean(captured.tui),
		renders: captured.tuiRenders,
		slashPromptInstalled: captured.slashPromptInstalled,
	};
}

/** Keep registered scope tools in the host's atomic vibe-mode activation. */
export function installVibeTools(AgentSession) {
	patchMethod(
		AgentSession?.prototype,
		"activateVibeTools",
		VIBE_PATCH,
		(original) =>
			function activateVibeTools(baseToolNames) {
				const registered = new Set(this.getAllToolNames());
				const tools = SCOPE_TOOLS.filter((name) => registered.has(name));
				return Reflect.apply(original, this, [
					[...new Set([...baseToolNames, ...tools])],
				]);
			},
	);
}

/**
 * Parse a leading slash command (`/name [args]`). Returns null for plain text.
 */
export function parseSlashCommand(text) {
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const match = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return null;
	return {
		name: match[1].toLowerCase(),
		args: (match[2] ?? "").trim(),
		raw: trimmed,
	};
}

/**
 * Load the host builtin slash-command dispatcher lazily when available.
 */
let cachedBuiltinExecutor;
async function resolveBuiltinSlashExecutor() {
	if (cachedBuiltinExecutor !== undefined) return cachedBuiltinExecutor;
	try {
		const mod = await import(
			"@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry"
		);
		cachedBuiltinExecutor =
			typeof mod?.executeBuiltinSlashCommand === "function"
				? mod.executeBuiltinSlashCommand
				: null;
	} catch {
		cachedBuiltinExecutor = null;
	}
	return cachedBuiltinExecutor;
}

/**
 * Send a prompt with unified builtin slash-command support across TUI, RPC,
 * and Print modes via the Route 2 Headless TUI Adapter.
 *
 * - Builtin slash commands (`/handoff`, `/vibe`, `/new`, `/fresh`, `/model`,
 *   `/compact`, etc.) run through the host's `executeBuiltinSlashCommand`
 *   (or local fallback when running isolated from the host package) backed by
 *   `createHeadlessTuiContext(session, options)`.
 * - Residual prompts returned by builtin commands, extension/custom slash
 *   commands, and plain text delegate to `session.prompt(text, options)`.
 * - `options.slashOnly` never falls through to `session.prompt` or
 *   `options.fallbackSend`; it returns a structured handled/residual result.
 */
function slashOnlyResult(handled, command, residual, headless) {
	const result = {
		handled,
		mode: "slash-only",
		command,
		outputs: headless?.outputs ?? [],
		result: headless?.station?.lastResult,
	};
	if (residual !== undefined) result.residual = residual;
	return result;
}

export async function sendSlashPrompt(target, text, options = {}) {
	const session = sessionFor(target) ?? target;
	const parsed = parseSlashCommand(text);
	const slashOnly = options.slashOnly === true || options.slash_only === true;
	let headless = null;

	if (parsed) {
		headless = createHeadlessTuiContext(session, options);
		const executor =
			typeof options.builtinExecutor === "function"
				? options.builtinExecutor
				: await resolveBuiltinSlashExecutor();
		let outcome = false;
		if (executor) {
			outcome = await executor(parsed.raw, {
				ctx: headless.ctx,
				input: options.input,
				draftDetached: false,
			});
		} else {
			outcome = await executeFallbackBuiltinSlashCommand(parsed, headless.ctx);
		}

		if (outcome === true) {
			if (slashOnly) return slashOnlyResult(true, parsed.name, undefined, headless);
			return {
				handled: true,
				mode: "session",
				command: parsed.name,
				outputs: headless.outputs,
				result: headless.station.lastResult,
			};
		}
		if (typeof outcome === "string") {
			if (slashOnly) {
				return slashOnlyResult(false, parsed.name, outcome, headless);
			}
			text = outcome;
		}
	}

	if (slashOnly) {
		return slashOnlyResult(false, parsed?.name ?? null, text, headless);
	}

	if (session && typeof session.prompt === "function") {
		return await session.prompt(text, options);
	}
	if (typeof options.fallbackSend === "function") {
		return await options.fallbackSend(text, options);
	}
	throw new Error("sendSlashPrompt: target session has no prompt() method.");
}

/**
 * Install `AgentSession.prototype.sendSlashPrompt` as a dedicated
 * slash-command-capable variant without altering `sendPrompt` or `prompt`.
 */
export function installSlashPrompt(AgentSession) {
	const captured = state();
	const prototype = AgentSession?.prototype;
	if (!prototype) return false;
	if (Object.hasOwn(prototype, SLASH_PROMPT_PATCH)) {
		captured.slashPromptInstalled = true;
		return true;
	}
	Object.defineProperty(prototype, SLASH_PROMPT_PATCH, { value: true });
	if (typeof prototype.sendSlashPrompt !== "function") {
		Object.defineProperty(prototype, "sendSlashPrompt", {
			value: function sendSlashPromptMethod(text, options) {
				remember(this);
				return sendSlashPrompt(this, text, options);
			},
			writable: true,
			configurable: true,
		});
	}
	captured.slashPromptInstalled = true;
	return true;
}

/**
 * Patch InteractiveMode once so the extension can reach the live TUI instance
 * and bind it to its owning AgentSession.
 */
export function installInteractiveCapture(InteractiveMode) {
	const captured = state();
	if (typeof InteractiveMode !== "function" || !InteractiveMode.prototype) {
		captured.interactiveError =
			"InteractiveMode is unavailable from the host package root";
		return captured;
	}
	const prototype = InteractiveMode.prototype;
	if (Object.hasOwn(prototype, INTERACTIVE_PATCH)) {
		captured.interactiveInstalled = true;
		captured.interactiveError = null;
		return captured;
	}
	const renderInitialMessages = prototype.renderInitialMessages;
	if (typeof renderInitialMessages !== "function") {
		captured.interactiveError =
			"InteractiveMode.prototype.renderInitialMessages is unavailable";
		return captured;
	}
	Object.defineProperty(prototype, INTERACTIVE_PATCH, { value: true });
	prototype.renderInitialMessages = function renderInitialMessagesCaptured(
		...args
	) {
		captured.tuiRenders += 1;
		rememberTui(this);
		return Reflect.apply(renderInitialMessages, this, args);
	};
	const handleHandoffCommand = prototype.handleHandoffCommand;
	if (typeof handleHandoffCommand === "function") {
		prototype.handleHandoffCommand = function handleHandoffCommandCaptured(
			...args
		) {
			rememberTui(this);
			return Reflect.apply(handleHandoffCommand, this, args);
		};
	}
	captured.interactiveInstalled = true;
	captured.interactiveError = null;
	return captured;
}

/** Replace the live agent message array. Returns false when unavailable. */
export function setAgentMessages(context, messages) {
	const session = sessionFor(context);
	try {
		const agentState = session?.agent?.state;
		if (!agentState || !Array.isArray(messages)) return false;
		agentState.messages = messages.slice();
		return true;
	} catch {
		return false;
	}
}

export function installRunnerCapture(AgentSession) {
	installVibeTools(AgentSession);
	installPromptCapture(AgentSession);
	installSlashPrompt(AgentSession);
	const captured = state();
	if (captured.installed) return captured;
	captured.installed = true;
	if (typeof AgentSession !== "function" || !AgentSession.prototype) {
		captured.error = "AgentSession is unavailable from the host package root";
		return captured;
	}
	const prototype = AgentSession.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "extensionRunner");
	if (!descriptor || typeof descriptor.get !== "function") {
		captured.error = "AgentSession.prototype.extensionRunner getter is unavailable";
		return captured;
	}
	captured.prototype = prototype;
	captured.descriptor = descriptor;
	patchGetter(
		prototype,
		"extensionRunner",
		Symbol.for("herdchestra-lite2.runner-getter.v1"),
		(original) =>
			function () {
				const runner = Reflect.apply(original, this, []);
				remember(this);
				return runner;
			},
	);
	captured.error = null;
	return captured;
}

/**
 * Capture the session from `prompt`, which every turn passes through.
 */
function installPromptCapture(AgentSession) {
	patchMethod(
		AgentSession?.prototype,
		"prompt",
		PROMPT_PATCH,
		(original) =>
			function prompt(...args) {
				remember(this);
				return Reflect.apply(original, this, args);
			},
	);
}
