// OMP validates the entire batch before dispatch. Install an admission gate
// on the resolved tool for calls that must wait for a scope barrier.
const agents = new WeakMap();
const guardedExecutions = new WeakMap();

function gateTool(tool, manager, admit) {
	let owner = tool;
	let descriptor;
	while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, "execute"))) {
		owner = Object.getPrototypeOf(owner);
	}
	let sessions = guardedExecutions.get(descriptor?.value);
	if (!sessions) {
		sessions = new WeakMap();
		// ACP exposes an execute getter through a Proxy. Define on its target
		// and keep the target implementation, not the outer approval closure.
		const execute = descriptor?.value ?? tool.execute;
		const guarded = async function (toolCallId, params, signal, onUpdate, ctx) {
			const gate = sessions.get(ctx?.sessionManager);
			const verdict = gate?.(toolCallId, tool.name, ctx);
			if (verdict?.block) throw new Error(verdict.reason);
			const limitMs = verdict?.limitMs ?? 0;
			const startedAt = Date.now();
			if (limitMs <= 0) {
				return execute.call(this, toolCallId, params, signal, onUpdate, ctx);
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), limitMs);
			const linked =
				signal && typeof AbortSignal.any === "function"
					? AbortSignal.any([signal, controller.signal])
					: controller.signal;
			const after = () =>
				!signal?.aborted && gate?.(toolCallId, tool.name, ctx, {
					elapsedMs: Date.now() - startedAt,
					limitMs,
				});
			let outcome;
			try {
				outcome = await execute.call(this, toolCallId, params, linked, onUpdate, ctx);
			} catch (error) {
				const replacement = after();
				if (replacement?.block) throw new Error(replacement.reason);
				throw error;
			} finally {
				clearTimeout(timer);
			}
			const replacement = after();
			if (replacement?.block) throw new Error(replacement.reason);
			return outcome;
		};
		Object.defineProperty(tool, "execute", {
			configurable: true,
			writable: true,
			value: guarded,
		});
		guardedExecutions.set(guarded, sessions);
	}
	sessions.set(manager, admit);
}

export function installScopeDispatch(session, prepare, admit) {
	const agent = session?.agent;
	if (typeof agent?.beforeToolCall !== "function") return;
	const installed = agents.get(agent);
	if (installed?.hook === agent.beforeToolCall) {
		installed.prepare = prepare;
		installed.admit = admit;
		return;
	}
	const original = agent.beforeToolCall;
	const dispatch = { prepare, admit };
	dispatch.hook = function (input, signal) {
		if (dispatch.prepare(input.assistantMessage, input.toolCall.id, input.tool.name)) {
			gateTool(input.tool, session.sessionManager, dispatch.admit);
		}
		return original.call(this, input, signal);
	};
	agent.beforeToolCall = dispatch.hook;
	agents.set(agent, dispatch);
}
