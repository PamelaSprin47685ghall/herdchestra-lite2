// Model the host's separate Agent and running-loop arrays. Production hooks
// prepare requests; this fixture only delivers events and runs those hooks.

import { rememberSession } from "../../host-omp/src/host/capture.mjs";

export function attachRequestPreparation(session, ctx) {
	const agent = session.agent;
	agent.state ??= {};
	agent.state.messages ??= [];
	agent.state.systemPrompt ??= [];
	agent.state.tools ??= [];
	const hooks = new Set();
	agent.addBeforeModelCallHook = (hook) => {
		hooks.add(hook);
		return () => hooks.delete(hook);
	};
	const loop = { messages: agent.state.messages.slice() };
	const fixture = {
		hooks,
		loop,
		append(...messages) {
			agent.state.messages.push(...messages);
			loop.messages.push(...messages);
		},
		beginRun() {
			loop.messages = agent.state.messages.slice();
		},
		async prepare(signal) {
			for (const hook of hooks) await hook(signal, loop);
			loop.systemPrompt = agent.state.systemPrompt;
			loop.tools = agent.state.tools;
			try {
				return structuredClone(loop.messages);
			} catch {
				return loop.messages.slice();
			}
		},
	};
	ctx.session = session;
	ctx.requestPreparation = fixture;
	Object.defineProperty(ctx, "agentMessages", {
		configurable: true,
		get: () => loop.messages,
	});
	rememberSession(session);
	return fixture;
}

export function appendRequestMessages(ctx, ...messages) {
	ctx.requestPreparation.append(...messages);
}
