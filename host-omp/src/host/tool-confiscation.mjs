// Tool confiscation: the host hides every native and MCP tool from the model
// and leaves exactly one — the core's `js` tool.
//
// The model then reaches its old tools as async methods on the `api` object the
// js ticket builds inside the vm. That is what makes a turn's capability set
// visible and enforceable: a tool the model must not use is not merely advised
// against, it is absent from the object and from the printed REPL probe.
//
// Nothing is destroyed by hiding it. The snapshot taken here is what keeps the
// hidden tools alive for two consumers:
//   - `listSpecs` feeds the static `.d.ts` compiler, so the model still reads
//     every tool's signature (in the fixed system prompt, never per turn), and
//   - `execute` routes an `api.<name>()` call from inside the vm back to the
//     real tool. Control-plane names never arrive here: the core's catalog
//     dispatches `scope_*` one-to-one first.
//
// Identity is the agent, not the session: a session can be rebound, an agent
// owns one tool list for its whole life.
//
// A write reaches this module by two roads: the gateway below, and a native tool
// invoked straight from the host (the `eval` bridge, or an agent the policy does
// not disarm). Both roads must pass the same file queue, so a write tool is also
// wrapped in place the first time it becomes visible here.

import { sessionOf, jsonSchemaOf, cwdOf } from "./adapter.mjs";
import { abortedError, isWriteTool, serializeWrite } from "./write-serialization.mjs";
import { record } from "./diagnostics.mjs";
import { executeWrappedGoalTool } from "./tickets/goal.mjs";

const JS_TOOL_NAME = "js";
// `src/core/policy.mjs` classifies an omp builtin read-only subagent as this.
// Such an agent never carries the core's `js` tool, and it keeps its own tools
// untouched: the check is a second fence, not the only one.

/** agent -> Map<toolName, tool>, captured the first time that agent was hidden. */
const CONFISCATED = new WeakMap();

/** Tool objects whose `execute` this module already wrapped. */
const WRAPPED_WRITE_TOOLS = new WeakSet();

/** Wrapper functions, so a copied tool object is still recognized as wrapped. */
const WRAPPED_EXECUTES = new WeakSet();

function toolsOf(agent) {
	const tools = agent?.state?.tools;
	return Array.isArray(tools) ? tools : null;
}

function agentOf(ctx) {
	try {
		return sessionOf(ctx)?.agent ?? ctx?.agent ?? null;
	} catch {
		return null;
	}
}

/** The working directory a tool carries on itself, for a context that has none. */
function toolCwdOf(tool) {
	try {
		const fromManager = tool?.session?.sessionManager?.getCwd?.();
		if (typeof fromManager === "string" && fromManager !== "") return fromManager;
	} catch {
		// A manager that throws is treated as absent.
	}
	try {
		const cwd = tool?.session?.cwd;
		if (typeof cwd === "string" && cwd !== "") return cwd;
	} catch {
		// A session that throws is treated as absent.
	}
	return null;
}

function isWrapped(tool) {
	return typeof tool?.execute === "function" && WRAPPED_EXECUTES.has(tool.execute);
}

/**
 * Wrap one write tool's `execute` so a direct host call takes the file queue.
 *
 * The wrapper is added in place, because the host and the snapshot must keep
 * pointing at one tool object. A frozen tool is left alone rather than thrown
 * over: the gateway still serializes every call it dispatches itself.
 */
function wrapWriteTool(tool) {
	if (!tool || typeof tool !== "object") return false;
	if (WRAPPED_WRITE_TOOLS.has(tool)) return false;
	const name = tool.name;
	if (!isWriteTool(name)) return false;
	const rawExecute = tool.execute;
	if (typeof rawExecute !== "function" || WRAPPED_EXECUTES.has(rawExecute)) return false;
	const wrapped = function execute(callId, args, signal, onUpdate, ctx) {
		const run = () => {
			if (signal?.aborted) throw abortedError(signal);
			return rawExecute.call(this, callId, args, signal, onUpdate, ctx);
		};
		const cwd = cwdOf(ctx) ?? toolCwdOf(tool);
		return serializeWrite(name, args, cwd, run, signal);
	};
	WRAPPED_EXECUTES.add(wrapped);
	try {
		tool.execute = wrapped;
	} catch {
		return false;
	}
	if (tool.execute !== wrapped) return false;
	WRAPPED_WRITE_TOOLS.add(tool);
	return true;
}

function wrapWriteTools(agent) {
	const tools = toolsOf(agent);
	if (!tools) return;
	for (const tool of tools) wrapWriteTool(tool);
}

function resolveStation(getEngine, ctx) {
	try {
		const engine = getEngine?.();
		if (!engine) return null;
		// Never create a station here. A `context` handler runs for every agent,
		// and building a station for a foreign context would race the root
		// station hook and leave a stray engine behind. Ask whether one already
		// exists; the policy check simply has no opinion when it does not.
  		if (typeof engine.hasStation === "function" && !engine.hasStation(ctx)) return null;
  		// One read-only entry: `peekStation` never mints a station, so a foreign
  		// context leaves the policy check with no opinion instead of racing the
  		// root hook.
  		if (typeof engine.peekStation === "function") return engine.peekStation(ctx) ?? null;
  		// A double may predate the read-only entry; `hasStation` is still a
  		// lookup, never a creation.
  		if (typeof engine.station === "function" && engine.hasStation?.(ctx) !== false) {
  			return engine.station(ctx) ?? null;
  		}
	} catch {
		// A host without a station yet is treated as unguided, not as foreign.
	}
	return null;
}

function policyAllows(getEngine, ctx) {
	try {
		const engine = getEngine?.();
		// The classification vocabulary belongs to the core; asking the engine
		// keeps this file from carrying a second copy of the string.
		if (typeof engine?.isReadOnlySubagent === "function") {
			return !engine.isReadOnlySubagent(ctx);
		}
		const station = resolveStation(getEngine, ctx);
		return !station || typeof station.policy !== "function";
	} catch {
		return true;
	}
}

/**
 * Hide every tool but `js` on this agent and return the snapshot of the rest.
 * Returns null when the agent is not ours to disarm, or when confiscation is
 * refused — in both cases the tool list is left exactly as the host built it.
 */
function confiscate(agent, allowed) {
	if (!agent || !allowed) return null;
	const tools = toolsOf(agent);
	if (!tools) return null;
	const jsTool = tools.find((tool) => tool?.name === JS_TOOL_NAME);
	// The core's `js` tool present is the proof this session is managed by this
	// extension. Without it the agent belongs to the host or a sibling
	// extension, and its tools must stay exactly as they are.
	if (!jsTool) return null;
	let snapshot = CONFISCATED.get(agent);
	if (!snapshot) {
		snapshot = new Map();
		CONFISCATED.set(agent, snapshot);
	}
	// More than one tool means the host rebuilt this turn's roster: an official
	// goal transition adds or removes `goal`. Reconcile the snapshot with that
	// roster so a tool the host withdrew cannot stay callable through `api`.
	if (tools.length > 1) {
		const visible = new Set();
		for (const tool of tools) {
			if (tool === jsTool || typeof tool?.name !== "string" || tool.name === "") continue;
			visible.add(tool.name);
			wrapWriteTool(tool);
			snapshot.set(tool.name, tool);
		}
		for (const name of [...snapshot.keys()]) {
			if (!visible.has(name)) snapshot.delete(name);
		}
		agent.state.tools = [jsTool];
	}
	return snapshot;
}

/** Snapshot this agent's tools, confiscating now if that has not happened. */
function snapshotFor(getEngine, ctx) {
	const agent = agentOf(ctx);
	if (!agent) return null;
	const existing = CONFISCATED.get(agent);
	if (existing) return existing;
	return confiscate(agent, policyAllows(getEngine, ctx));
}

/**
 * Confiscate on every request boundary.
 *
 * `before_agent_start` and `context` both fire after the host has rebuilt its
 * tool list for the turn, which is exactly when a native or MCP tool would
 * reappear. Registering on both makes the hiding idempotent per turn instead of
 * hoping one event always precedes the request.
 */
/**
 * Re-run confiscation for one context. A preload that adds `goal` to the live
 * roster grows the snapshot immediately, so no later hook can observe a
 * half-updated tool list.
 */
export function confiscateContext(getEngine, ctx) {
	try {
		const agent = agentOf(ctx);
		const allowed = policyAllows(getEngine, ctx);
		// Wrap before hiding: a managed agent's write tools leave the visible
		// list but stay reachable through the snapshot and through the host's
		// own bridge, and both must find the queue.
		wrapWriteTools(agent);
		return confiscate(agent, allowed);
	} catch (error) {
		record("activation", error, { phase: "tool-confiscation" });
		return null;
	}
}

export function installToolConfiscation(pi, getEngine = () => null) {
	const apply = (_event, ctx) => {
		confiscateContext(getEngine, ctx);
		return undefined;
	};
	for (const event of ["session_start", "before_agent_start", "context"]) {
		try {
			pi.on(event, apply);
		} catch {
			// A host that refuses one event still hides on the others.
		}
	}
}

/**
 * The host-side tool surface the core sees.
 *
 * `listSpecs` and `execute` are the two contract entries
 * (`HOST_CONTRACT.tools`). Every function is safe to call before the engine
 * exists: a spec list degrades to empty and a dispatch to a hidden tool throws
 * a plain error the script can catch.
 */
export function createToolGateway(getEngine = () => null) {
	function toolFor(ctx, name) {
		const snapshot = snapshotFor(getEngine, ctx);
		const fromSnapshot = snapshot?.get(name);
		if (fromSnapshot) return fromSnapshot;
		const tools = toolsOf(agentOf(ctx));
		return tools?.find((tool) => tool?.name === name) ?? null;
	}

	function listSpecs(ctx) {
		const snapshot = snapshotFor(getEngine, ctx);
		const specs = [];
		if (!snapshot) return specs;
		for (const [name, tool] of snapshot) {
			specs.push({
				name,
				description: typeof tool?.description === "string" ? tool.description : "",
				parameters: jsonSchemaOf(tool) ?? { type: "object" },
			});
		}
		// Sorted here as well as in the compiler: a stable list keeps the
		// compiled declaration block byte-identical across turns.
		specs.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		return specs;
	}

	function execute(name, callId, args, signal, onUpdate, ctx) {
		if (typeof name !== "string" || name === "") {
			throw new Error("Tool dispatch requires a tool name.");
		}
		const engine = getEngine?.() ?? null;
		// This gateway is the host contract's `execute`, so it must answer a
		// control-plane name even when the caller bypassed the core funnel in
		// `catalog.mjs`. A missing `coreTools` is a wiring gap, not a model
		// error, so it is reported as an unavailable tool rather than a crash.
		const control = name.startsWith("scope_") ? engine?.coreTools?.[name] ?? null : null;
		const tool = control ?? toolFor(ctx, name);
		// The official goal is one host tool with a runtime-backed surface. It
		// stays inside the `js` call: the model reaches it as `api.goal`, never
		// as a second top-level tool.
		if (name === "goal" && !control) {
			return executeWrappedGoalTool(
				args,
				ctx,
				engine?.peekStation?.(ctx) ?? null,
				tool && typeof tool.execute === "function" ? tool : null,
				{ callId, signal, onUpdate },
			);
		}
		if (!tool || typeof tool.execute !== "function") {
			throw new Error(`Tool "${name}" is not available in this turn.`);
		}
		// The live `ctx` travels through untouched: the host's UI fences
		// (approval dialogs, web/TUI racing) are bound to it.
		const run = () => {
			if (signal?.aborted) throw abortedError(signal);
			return tool.execute(callId, args, signal, onUpdate, ctx);
		};
		// A read-modify-write of one file loses the earlier write when two run
		// at once, and both report success. Serialize the write-class tools per
		// resolved path; reads and distinct paths keep running in parallel.
		if (!isWriteTool(name)) return run();
		// A wrapped tool takes its own lock. Taking the lock here as well would make
		// the call wait for itself.
		if (isWrapped(tool)) return run();
		return serializeWrite(name, args, cwdOf(ctx), run, signal);
	}

	return { listSpecs, execute };
}
