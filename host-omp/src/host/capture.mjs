/**
 * Host capture for omp: the live AgentSession seam, the builtin slash
 * executor, and a strict slash dispatcher.
 *
 * The slash route is not a model-facing tool; it is how a forked scope applies
 * its own `model` selection (`switchModelTicket` -> `sendSlashPrompt`). It
 * stays even though the model never issues a slash command itself.
 *
 * One narrow patch remains: the `extensionRunner` getter binds the live
 * AgentSession to its SessionManager, because the extension context exposes the
 * manager but not the session. Everything else uses public host API.
 */

import { createHeadlessTuiContext } from "./headless-tui.mjs";
import { captureTranscriptSubscriptions } from "./child-display.mjs";

  import {
  	ABORT_PATCH,
  	RUNNER_GETTER_PATCH,
  	VIBE_PATCH,
  } from "./process-symbols.mjs";
  import { getProcessRegistry } from "./process-registry.mjs";
// Upstream interrupt labels from pi-coding-agent/src/session/transcript/messages.ts.
// Native TUI Esc, Web UI ctx.abort(), ACP cancel, and parent kill all enter
// AgentSession.prototype.abort with one of these labels. Internal lifecycle
// aborts (/compact, /new, /switch, dispose) omit the reason, and queued-message
// redirect sets `deliverQueuedMessages: true`.
const USER_INTERRUPT_REASONS = new Set([
	"Interrupted by user",
	"Stopped by parent agent",
]);
// Vibe mode re-activates a tool set from a base list. The core registers
// exactly one tool, so that is the whole set this patch must keep alive; the
// retired scope_* names must never come back through this door.
const SCOPE_TOOLS = ["js"];

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

  /** What a fresh capture record holds. The registry owns the slot, this owns the shape. */
  function freshCaptureState() {
  	return {
  		installed: false,
  		error: null,
  		prototype: null,
  		descriptor: null,
  		sessions: new WeakMap(),
  		managerSessions: new WeakMap(),
  		sessionRefs: new WeakMap(),
  		abortListeners: new Set(),
  		builtinSlashExecutor: null,
  		seams: freshSeams(),
  	};
  }

  function state() {
  	const existing = getProcessRegistry().captureState(freshCaptureState);
  	// A record that outlived an older copy of this package may lack a container;
  	// each one is created on first use rather than assumed present.
  	if (!existing.seams) existing.seams = freshSeams();
  	if (!existing.managerSessions) existing.managerSessions = new WeakMap();
  	if (!existing.sessionRefs) existing.sessionRefs = new WeakMap();
  	if (!existing.abortListeners) existing.abortListeners = new Set();
  	return existing;
  }

/**
 * Whether `AgentSession.prototype.abort(options)` represents an explicit user
 * (or parent-kill) abort rather than an internal lifecycle teardown or a
 * steer/follow-up redirect.
 */
export function isUserAbortOptions(options) {
	if (!options || typeof options !== "object") return false;
	if (options.deliverQueuedMessages === true) return false;
	return USER_INTERRUPT_REASONS.has(options.reason);
}

/**
 * Subscribe to synchronous user-abort notifications fired from the entry of
 * `AgentSession.prototype.abort` before the host awaits idle unwind.
 */
export function registerUserAbortListener(listener) {
	if (typeof listener !== "function") return () => {};
	const listeners = state().abortListeners;
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function notifyUserAbort(session, evidence) {
	for (const listener of [...state().abortListeners]) {
		try {
			listener(session, evidence);
		} catch {
			// A listener error must never block the host's own abort unwind.
		}
	}
}

export function installAbortCapture(AgentSession) {
	return patchMethod(
		AgentSession?.prototype,
		"abort",
		ABORT_PATCH,
		(original) =>
			function abort(options, ...rest) {
				remember(this);
				if (isUserAbortOptions(options)) {
					notifyUserAbort(this, {
						kind: "USER_ABORT",
						source: "session-abort",
						reason: options.reason,
					});
				}
				return Reflect.apply(original, this, [options, ...rest]);
			},
	);
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
 * This route carries a scoped model switch: the fork ticket names the model,
 * and the switch itself is performed by the host's own `/switch` command
 * against the child session. No prompt or message text is ever sent.
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
	installAbortCapture(AgentSession);
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
