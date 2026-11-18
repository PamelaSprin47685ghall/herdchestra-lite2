/**
 * Capture the live AgentSession and InteractiveMode of the running omp host.
 *
 * The host re-exports the exact AgentSession class it instantiates. Its public
 * `extensionRunner` getter is read by the host around tool dispatch, so wrapping
 * that one getter observes the real session without importing a deep module.
 *
 * `InteractiveMode` is captured through `renderInitialMessages`, which the TUI
 * calls before its first transcript paint. The captured instance lets the stop
 * hook invoke the built-in handoff command, so the TUI rebuilds its transcript
 * and shows the compaction divider. Both patches are optional: when a host does
 * not expose the class, scope accounting still works from the public session
 * manager and the handoff falls back to the real AgentSession method.
 *
 * Sessions are remembered per SessionManager, never as a global "last session",
 * because extension instances can serve several sessions with different cwds.
 */

const STATE_KEY = Symbol.for("herdchestra-lite2.session-capture.v1");
const VIBE_PATCH = Symbol.for("herdchestra-lite2.vibe-tools.v1");
const PROMPT_PATCH = Symbol.for("herdchestra-lite2.prompt-capture.v1");
const INTERACTIVE_PATCH = Symbol.for("herdchestra-lite2.tui-capture.v1");
const SCOPE_TOOLS = ["scope", "regret", "defer", "pin", "todo"];

/** Keep registered scope tools in the host's atomic vibe-mode activation. */
export function installVibeTools(AgentSession) {
	const prototype = AgentSession?.prototype;
	if (!prototype || Object.hasOwn(prototype, VIBE_PATCH)) return;
	const original = prototype.activateVibeTools;
	if (typeof original !== "function") return;
	Object.defineProperty(prototype, VIBE_PATCH, { value: true });
	prototype.activateVibeTools = function (baseToolNames) {
		const registered = new Set(this.getAllToolNames());
		const tools = SCOPE_TOOLS.filter((name) => registered.has(name));
		return Reflect.apply(original, this, [[...new Set([...baseToolNames, ...tools])]]);
	};
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
		tui: null,
		tuiRenders: 0,
		interactiveInstalled: false,
		interactiveError: null,
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

/** The live AgentSession bound to this extension context, or null. */
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

/** Test and host seam: bind the live InteractiveMode instance. */
export function rememberTui(tui) {
	state().tui = tui ?? null;
}

/** The live InteractiveMode instance for the main session, or null. */
export function tuiFor() {
	return state().tui ?? null;
}

/** Capture instrumentation for logs. */
export function interactiveCaptureState() {
	const captured = state();
	return {
		installed: captured.interactiveInstalled,
		error: captured.interactiveError,
		hasTui: Boolean(captured.tui),
		renders: captured.tuiRenders,
	};
}

/**
 * Patch InteractiveMode once so the extension can reach the live TUI instance.
 * `renderInitialMessages` runs before the first transcript paint; wrapping the
 * built-in handoff command also catches an instance whose first render was
 * skipped. Both wrappers only remember `this` and delegate unchanged.
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
	const original = descriptor.get;
	Object.defineProperty(prototype, "extensionRunner", {
		...descriptor,
		get() {
			const runner = Reflect.apply(original, this, []);
			remember(this);
			return runner;
		},
	});
	captured.error = null;
	return captured;
}

/**
 * Capture the session from `prompt`, which every turn passes through. The
 * extensionRunner getter alone is not enough: some host paths never read it
 * before a tool execute, and 18.x no longer switches sessions for handoff.
 */
function installPromptCapture(AgentSession) {
	const prototype = AgentSession?.prototype;
	if (!prototype || Object.hasOwn(prototype, PROMPT_PATCH)) return;
	const original = prototype.prompt;
	if (typeof original !== "function") return;
	Object.defineProperty(prototype, PROMPT_PATCH, { value: true });
	prototype.prompt = function prompt(...args) {
		remember(this);
		return Reflect.apply(original, this, args);
	};
}
