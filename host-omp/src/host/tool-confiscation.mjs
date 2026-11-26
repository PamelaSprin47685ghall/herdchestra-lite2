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

import { sessionOf, jsonSchemaOf } from "./adapter.mjs";
import { record } from "./diagnostics.mjs";

const JS_TOOL_NAME = "js";
// `src/core/policy.mjs` classifies an omp builtin read-only subagent as this.
// Such an agent never carries the core's `js` tool, and it keeps its own tools
// untouched: the check is a second fence, not the only one.
const READ_ONLY_SUBAGENT = "read-only-subagent";

/** agent -> Map<toolName, tool>, captured the first time that agent was hidden. */
const CONFISCATED = new WeakMap();

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

function resolveStation(getEngine, ctx) {
	try {
		const engine = getEngine?.();
		if (!engine) return null;
		// Never create a station here. A `context` handler runs for every agent,
		// and building a station for a foreign context would race the root
		// station hook and leave a stray engine behind. Ask whether one already
		// exists; the policy check simply has no opinion when it does not.
		if (typeof engine.hasStation === "function" && !engine.hasStation(ctx)) return null;
		if (typeof engine.station === "function") return engine.station(ctx) ?? null;
		if (typeof engine.stationFor === "function") return engine.stationFor(ctx) ?? null;
	} catch {
		// A host without a station yet is treated as unguided, not as foreign.
	}
	return null;
}

function policyAllows(getEngine, ctx) {
	const station = resolveStation(getEngine, ctx);
	if (!station || typeof station.policy !== "function") return true;
	try {
		return station.policy(ctx) !== READ_ONLY_SUBAGENT;
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
	for (const tool of tools) {
		if (tool === jsTool || typeof tool?.name !== "string" || tool.name === "") continue;
		if (!snapshot.has(tool.name)) snapshot.set(tool.name, tool);
	}
	if (tools.length > 1) agent.state.tools = [jsTool];
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
export function installToolConfiscation(pi, getEngine = () => null) {
	const apply = (_event, ctx) => {
		try {
			confiscate(agentOf(ctx), policyAllows(getEngine, ctx));
		} catch (error) {
			record("activation", error, { phase: "tool-confiscation" });
		}
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
		if (!tool || typeof tool.execute !== "function") {
			throw new Error(`Tool "${name}" is not available in this turn.`);
		}
		// The live `ctx` travels through untouched: the host's UI fences
		// (approval dialogs, web/TUI racing) are bound to it.
		return tool.execute(callId, args, signal, onUpdate, ctx);
	}

	return { listSpecs, execute };
}
