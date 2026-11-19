// Host adapter: the one module that knows the host object's shape.
//
// Every other module asks these functions instead of probing `ctx.session`,
// `session.agent.state`, or `ctx.modelRegistry` itself. `capture.sessionFor`
// stays the authority for binding a live session; this adapter only reads the
// objects around it, so the dependency points one way.

import { sessionFor } from "./capture.mjs";

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

/** The live session bound to this context, or null. Never throws. */
export function sessionOf(ctx) {
	try {
		const session = sessionFor(ctx);
		if (session) return session;
	} catch {
		// A host that throws from its capture hook is treated as absent.
	}
	return read(ctx, "session") ?? null;
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
