// OMP validates the entire batch before dispatch. Install an admission gate
// on the resolved tool for calls that must wait for a scope barrier.
const agents = new WeakMap();
const guardedExecutions = new WeakMap();

function agentIdOf(target) {
	if (!target || (typeof target !== "object" && typeof target !== "function")) return null;
	try {
		if (typeof target.getAgentId === "function") {
			const id = target.getAgentId();
			if (typeof id === "string" && id !== "") return id;
		}
	} catch {
		// A throwing getter must not decide routing.
	}
	const id = target.agent?.id;
	return typeof id === "string" && id !== "" ? id : null;
}

function gateTool(tool, manager, admit, agentId = null) {
	let owner = tool;
	let descriptor;
	while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, "execute"))) {
		owner = Object.getPrototypeOf(owner);
	}
	let routes = guardedExecutions.get(descriptor?.value);
	if (!routes) {
		routes = { byAgentId: new Map(), byManager: new WeakMap() };
		// ACP exposes an execute getter through a Proxy. Define on its target
		// and keep the target implementation, not the outer approval closure.
		const execute = descriptor?.value ?? tool.execute;
		const guarded = async function (toolCallId, params, signal, onUpdate, ctx) {
			// The owner and every flow share one SessionManager, so a manager
			// key alone hands a flow the last station that registered. The
			// agent id is the caller's own identity and wins when present.
			const id = agentIdOf(ctx);
			const gate =
				(id ? routes.byAgentId.get(id) : undefined) ??
				(ctx?.sessionManager ? routes.byManager.get(ctx.sessionManager) : undefined);
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
		guardedExecutions.set(guarded, routes);
	}
	if (agentId) routes.byAgentId.set(agentId, admit);
	if (manager) routes.byManager.set(manager, admit);
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
	const agentId = agentIdOf(session);
	const original = agent.beforeToolCall;
	const dispatch = { prepare, admit };
	dispatch.hook = function (input, signal) {
		if (dispatch.prepare(input.assistantMessage, input.toolCall.id, input.tool.name)) {
			gateTool(input.tool, session.sessionManager, dispatch.admit, agentId);
		}
		return original.call(this, input, signal);
	};
	agent.beforeToolCall = dispatch.hook;
	agents.set(agent, dispatch);
}
