/**
 * Capture the live AgentSession of the running omp host.
 *
 * The host re-exports the exact AgentSession class it instantiates. Its public
 * `extensionRunner` getter is read by the host around tool dispatch, so wrapping
 * that one getter observes the real session without importing a deep module.
 *
 * This is the only host patch in Herdchestra Lite 2.0. It is optional: when the
 * getter is absent, scope accounting still works because the session manager is
 * public on the extension context. Only the agent-state rebase is skipped.
 *
 * Sessions are remembered per SessionManager, never as a global "last session",
 * because extension instances can serve several sessions with different cwds.
 */

const STATE_KEY = Symbol.for("herdchestra-lite2.session-capture.v1");
const VIBE_PATCH = Symbol.for("herdchestra-lite2.vibe-tools.v1");
const SCOPE_TOOLS = ["scope", "regret", "defer", "pin"];

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
