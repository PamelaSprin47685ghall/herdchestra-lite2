/**
 * Host capture for omp: the live AgentSession seam, the builtin slash
 * executor, and a strict slash dispatcher.
 *
 * One narrow patch remains: the `extensionRunner` getter binds the live
 * AgentSession to its SessionManager, because the extension context exposes the
 * manager but not the session. Everything else uses public host API.
 */

import { createHeadlessTuiContext } from "./headless-tui.mjs";

const STATE_KEY = Symbol.for("herdchestra-lite2.session-capture.v2");
const VIBE_PATCH = Symbol.for("herdchestra-lite2.vibe-tools.v2");
const RUNNER_GETTER_PATCH = Symbol.for("herdchestra-lite2.runner-getter.v2");
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
	if (existing) {
		if (!existing.seams) existing.seams = freshSeams();
		return existing;
	}
	const created = {
		installed: false,
		error: null,
		prototype: null,
		descriptor: null,
		sessions: new WeakMap(),
		builtinSlashExecutor: null,
		seams: freshSeams(),
	};
	Object.defineProperty(globalThis, STATE_KEY, {
		value: created,
		enumerable: false,
		configurable: true,
	});
	return created;
}

/** The three host seams this extension patches, and their last verdict. */
function freshSeams() {
	return { vibeTools: false, runnerGetter: false, sessionMessages: null };
}

/**
 * Summarize the host seam state. A missing seam degrades folding and the
 * relay silently, so a caller must be able to see it.
 *
 * `agent.state.messages` stays unknown (null) until the first write, so an
 * idle session does not report a seam it never touched.
 */
export function captureDiagnosis() {
	const captured = state();
	const missing = [];
	if (!captured.seams.vibeTools) missing.push("activateVibeTools");
	if (!captured.seams.runnerGetter) missing.push("extensionRunner");
	if (captured.seams.sessionMessages === false) {
		missing.push("agent.state.messages");
	}
	return {
		ok: missing.length === 0 && captured.error === null,
		missing,
		error: captured.error,
	};
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

/** Keep registered scope tools in the host's atomic vibe-mode activation. */
export function installVibeTools(AgentSession) {
	const patched = patchMethod(
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
	const captured = state();
	captured.seams.vibeTools = Boolean(captured.seams.vibeTools || patched);
	return captured.seams.vibeTools;
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

export function installBuiltinSlashExecutor(executor) {
	const captured = state();
	const previous = captured.builtinSlashExecutor;
	if (typeof executor === "function") captured.builtinSlashExecutor = executor;
	return () => {
		captured.builtinSlashExecutor = previous;
	};
}

/**
 * Execute one system slash command and wait for its completion promise.
 *
 * This route remains for model selection (`/switch`, `/model`). The relay
 * handoff no longer passes through the slash dispatcher: it calls
 * `session.compact(focus, { mode: "handoff" })`, the same call the builtin
 * `/handoff` makes, so no prompt or message is ever sent.
 */
export async function sendSlashPrompt(target, text, options = {}) {
	const session = sessionFor(target) ?? target;
	const parsed = parseSlashCommand(text);
	if (!parsed) throw new Error("sendSlashPrompt requires a slash command");
	const executor =
		typeof options.builtinExecutor === "function"
			? options.builtinExecutor
			: state().builtinSlashExecutor;
	if (typeof executor !== "function") {
		throw new Error(
			"The system slash-command executor is unavailable; /handoff cannot run",
		);
	}
	const headless = createHeadlessTuiContext(session, options);
	const outcome = await executor(parsed.raw, {
		ctx: headless.ctx,
		input: options.input,
		draftDetached: false,
	});
	if (outcome !== true) {
		return {
			handled: false,
			command: parsed.name,
			outputs: headless.outputs,
			residual: typeof outcome === "string" ? outcome : undefined,
		};
	}
	return {
		handled: true,
		mode: "slash",
		command: parsed.name,
		outputs: headless.outputs,
	};
}

/** Replace the live agent message array. Returns false when unavailable. */
export function setAgentMessages(context, messages) {
	const session = sessionFor(context);
	try {
		const agentState = session?.agent?.state;
		if (!agentState || !Array.isArray(messages)) return false;
		agentState.messages = messages.slice();
		state().seams.sessionMessages = true;
		return true;
	} catch {
		state().seams.sessionMessages = false;
		return false;
	}
}

/**
 * Install both prototype patches and report the resulting seam diagnosis.
 *
 * Callers ask "did it work", so the return value is `captureDiagnosis()`, not
 * the internal record: an `ok`/`missing`/`error` shape cannot be misread, and
 * the diagnosis is current after the install.
 */
export function installRunnerCapture(AgentSession) {
	installVibeTools(AgentSession);
	const captured = state();
	if (captured.installed) return captureDiagnosis();
	captured.installed = true;
	if (typeof AgentSession !== "function" || !AgentSession.prototype) {
		captured.error = "AgentSession is unavailable from the host package root";
		return captureDiagnosis();
	}
	const prototype = AgentSession.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "extensionRunner");
	if (!descriptor || typeof descriptor.get !== "function") {
		captured.error = "AgentSession.prototype.extensionRunner getter is unavailable";
		return captureDiagnosis();
	}
	captured.prototype = prototype;
	captured.descriptor = descriptor;
	patchGetter(
		prototype,
		"extensionRunner",
		RUNNER_GETTER_PATCH,
		(original) =>
			function () {
				const runner = Reflect.apply(original, this, []);
				remember(this);
				return runner;
			},
	);
	captured.seams.runnerGetter = true;
	captured.error = null;
	return captureDiagnosis();
}
