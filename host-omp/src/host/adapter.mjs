// Host adapter: the one module that knows the host object's shape.
//
// Every other module asks these functions instead of probing `ctx.session`,
// `session.agent.state`, or `ctx.modelRegistry` itself. `capture.sessionFor`
// stays the authority for binding a live session; this adapter only reads the
// objects around it, so the dependency points one way.

import { sessionFor, sessionMatchesContext } from "./capture.mjs";

function read(target, key) {
	if (!target || typeof target !== "object") return undefined;
	try {
		return target[key];
	} catch {
		return undefined;
	}
}

function agentState(target) {
	return read(read(target, "agent"), "state");
}

/**
 * The live session bound to this context, or null. Never throws.
 *
 * `capture` resolves explicit sessions before manager bindings. Shared
 * managers require an agent id. Check the identity on every fallback too, so
 * a stale `ctx.session` cannot send a flow's writes to its owner.
 */
export function sessionOf(ctx) {
	try {
		const session = sessionFor(ctx);
		if (sessionMatchesContext(session, ctx)) return session;
	} catch {
		// A host that throws from its capture hook is treated as absent.
	}
	const session = read(ctx, "session");
	return sessionMatchesContext(session, ctx) ? session : null;
}

export function managerOf(ctx) {
	return read(ctx, "sessionManager") ?? read(sessionOf(ctx), "sessionManager") ?? null;
}

export function modelFrom(holder) {
	return read(holder, "model") ?? read(agentState(holder), "model") ?? null;
}

export function thinkingFrom(holder) {
	const level =
		read(holder, "thinkingLevel") ??
		read(agentState(holder), "thinkingLevel") ??
		read(holder, "thinking");
	return typeof level === "string" && level ? level : null;
}

export function modelOf(ctx) {
	return modelFrom(sessionOf(ctx)) ?? modelFrom(ctx) ?? null;
}

export function thinkingOf(ctx) {
	return thinkingFrom(sessionOf(ctx)) ?? thinkingFrom(ctx) ?? null;
}

export function modelRegistryOf(ctx) {
	return read(ctx, "modelRegistry") ?? read(sessionOf(ctx), "modelRegistry") ?? null;
}

export function settingsOf(ctx) {
	return read(ctx, "settings") ?? read(sessionOf(ctx), "settings") ?? null;
}

/** The session's live message list, or null when the host has none. */
export function messagesOf(ctx) {
	const messages = read(agentState(sessionOf(ctx)), "messages");
	return Array.isArray(messages) ? messages : null;
}

/**
 * One tool's JSON Schema, as the host declares it.
 *
 * Current hosts use callable ArkType schemas; JSON.stringify would silently
 * omit those functions and undercount the tool header. An extension-registered
 * tool already carries a plain JSON Schema object and passes through. Null
 * means "this tool's schema cannot be read", so callers degrade instead of
 * sending a wrong shape to the model.
 */
export function jsonSchemaOf(tool) {
	let parameters = tool?.parameters;
	if (typeof parameters === "function") {
		if (typeof parameters.toJsonSchema !== "function") return null;
		try {
			parameters = parameters.toJsonSchema({
				target: "draft-2020-12",
				fallback: (value) => value.base,
			});
		} catch {
			return null;
		}
	}
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return null;
	return parameters;
}

/** Serializable request header used to estimate a new model's fixed cost. */
export function contextHeaderOf(ctx) {
	const state = agentState(sessionOf(ctx));
	const systemPrompt = read(state, "systemPrompt");
	const tools = read(state, "tools");
	if ((typeof systemPrompt !== "string" && !Array.isArray(systemPrompt)) || !Array.isArray(tools)) {
		return null;
	}
	try {
		const definitions = [];
		for (const tool of tools) {
			const parameters = jsonSchemaOf(tool);
			if (!parameters) return null;
			definitions.push({ name: tool.name, description: tool.description, parameters });
		}
		return JSON.parse(JSON.stringify({ systemPrompt, tools: definitions }));
	} catch {
		return null;
	}
}

/** One flat view of every host object the extension reads. */
export function hostView(ctx) {
	const session = sessionOf(ctx);
	return {
		session,
		manager: managerOf(ctx),
		model: modelOf(ctx),
		thinkingLevel: thinkingOf(ctx),
		modelRegistry: modelRegistryOf(ctx),
		settings: settingsOf(ctx),
	};
}

/** Which host capabilities were present, for one diagnostic record. */
export function capabilities(ctx) {
	const view = hostView(ctx);
	return Object.freeze({
		session: view.session !== null,
		manager: view.manager !== null,
		model: view.model !== null,
		thinking: view.thinkingLevel !== null,
		modelRegistry: view.modelRegistry !== null,
		settings: view.settings !== null,
	});
}
