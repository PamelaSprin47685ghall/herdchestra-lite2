/**
 * Host capture for omp: the live AgentSession seam, the builtin slash
 * executor, and a strict slash dispatcher.
 *
 * One narrow patch remains: the `extensionRunner` getter binds the live
 * AgentSession to its SessionManager, because the extension context exposes the
 * manager but not the session. Everything else uses public host API.
 */

import { createHeadlessTuiContext } from "./headless-tui.mjs";
import { captureTranscriptSubscriptions } from "./child-display.mjs";

const STATE_KEY = Symbol.for("herdchestra-lite2.session-capture.v2");
const VIBE_PATCH = Symbol.for("herdchestra-lite2.vibe-tools.v2");
const RUNNER_GETTER_PATCH = Symbol.for("herdchestra-lite2.runner-getter.v2");
// The retired `amend` and `pin` stay here so an older transcript is still
// recognized as carrying scope tools.
const SCOPE_TOOLS = ["scope_fork", "scope_join", "scope_return", "scope_context", "amend", "pin", "todo"];

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
		if (!existing.managerSessions) existing.managerSessions = new WeakMap();
		if (!existing.sessionRefs) existing.sessionRefs = new WeakMap();
		return existing;
	}
	const created = {
		installed: false,
		error: null,
		prototype: null,
		descriptor: null,
		sessions: new WeakMap(),
		managerSessions: new WeakMap(),
		sessionRefs: new WeakMap(),
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

function isObject(value) {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

function read(target, key) {
	if (!isObject(target)) return undefined;
	try {
		return target[key];
	} catch {
		return undefined;
	}
}

function agentId(session) {
	try {
		const getId = read(session, "getAgentId");
		const id = typeof getId === "function" ? getId.call(session) : null;
		if (typeof id === "string" && id !== "") return id;
	} catch {
		// Older hosts can expose the id on the agent instead.
	}
	const id = read(read(session, "agent"), "id");
	return typeof id === "string" && id !== "" ? id : null;
}

/** Reject a known identity conflict. Hosts without agent ids remain supported. */
export function sessionMatchesContext(session, context) {
	if (!isObject(session)) return false;
	const expected = agentId(context);
	const actual = agentId(session);
	return expected === null || actual === null || actual === expected;
}

function bindManager(captured, manager, reference) {
	if (!isObject(manager)) return;
	let sessions = captured.managerSessions.get(manager);
	if (!sessions) {
		sessions = new Set();
		captured.managerSessions.set(manager, sessions);
	}
	sessions.add(reference);
}

function remember(session, sharedManager) {
	if (!isObject(session)) return;
	const captured = state();
	captured.sessions.set(session, session);
	const manager = read(session, "sessionManager");
	let reference = captured.sessionRefs.get(session);
	if (!reference || reference.manager !== manager) {
		reference = { session: new WeakRef(session), manager };
		captured.sessionRefs.set(session, reference);
	}
	bindManager(captured, manager, reference);
	bindManager(captured, sharedManager, reference);
	// Remove the old one-session-per-manager alias when the module is reloaded.
	if (isObject(manager) && manager !== session) captured.sessions.delete(manager);
}

/** Bind a live session, plus a raw manager when the host exposes a flow proxy. */
export function rememberSession(session, sharedManager) {
	remember(session, sharedManager);
}

function sessionByManager(manager, expected) {
	if (!isObject(manager)) return null;
	const captured = state();
	let references = captured.managerSessions.get(manager);
	if (!references) {
		const previous = captured.sessions.get(manager);
		if (previous && previous !== manager) remember(previous);
		references = captured.managerSessions.get(manager);
	}
	if (!references) return null;
	const sessions = [];
	const matches = [];
	for (const reference of references) {
		const session = reference.session.deref();
		if (
			!session ||
			read(session, "sessionManager") !== reference.manager ||
			captured.sessionRefs.get(session) !== reference
		) {
			references.delete(reference);
			continue;
		}
		sessions.push(session);
		if (expected !== null && agentId(session) === expected) matches.push(session);
	}
	if (matches.length === 1) return matches[0];
	if (matches.length > 1 || sessions.length !== 1) return null;
	const session = sessions[0];
	// A single legacy session can have no id. Several sessions cannot be guessed.
	return expected === null || agentId(session) === null ? session : null;
}

/** The live AgentSession bound to this extension context or session, or null. */
export function sessionFor(context) {
	if (!isObject(context)) return null;
	const direct = state().sessions.get(context);
	if (direct === context) return direct;
	const explicit = read(context, "session");
	if (sessionMatchesContext(explicit, context)) return explicit;
	const manager = read(context, "sessionManager") ?? context;
	return sessionByManager(manager, agentId(context));
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
	captureTranscriptSubscriptions(prototype);
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
