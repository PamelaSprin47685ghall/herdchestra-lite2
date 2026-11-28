/**
 * Activation domain index: assemble the extension from stations, hooks, and
 * tools. Mechanical only. No business logic lives here.
 */

import { createEngine } from "herdchestra-lite2";
import { agentIdOf, conversationKeyOf, sameManager } from "../host/identity-adapters.mjs";
  import {
  	branchOf,
  	capabilities,
  	contextHeaderOf,
  	managerOf,
  	modelOf,
  	settingsFor,
  	thinkingOf,
  } from "../host/adapter.mjs";
import { appendHistoryMessage } from "../host/hack-context.mjs";
import { sessionFor, setAgentMessages } from "../host/capture.mjs";
import { abortChildSession, interruptChildSession, registerProcessUserAbortEngine } from "../host/user-abort.mjs";
import { createToolGateway, installToolConfiscation } from "../host/tool-confiscation.mjs";
import { charsToTokens, createEmptyCatalog, preparseModelSpec } from "../host/pricing.mjs";
import { entryUsage, totalInput, usageSnapshot } from "../host/usage.mjs";
import {
	refreshStationDisplay,
	resolveStationBinding,
} from "../host/activation-binding.mjs";

import { record } from "../host/diagnostics.mjs";
import { wireCommands } from "./commands.mjs";
import { wireHostDiagnosis } from "./diagnosis.mjs";
import { buildTickets } from "./tickets.mjs";
import { installCapture } from "./capture.mjs";
import { wireHooks } from "./hooks.mjs";
import { bindScopeView } from "../host/child-display.mjs";
import { canRewindRoot } from "../host/host-tickets.mjs";

export { installCapture };

// The one fork wiring for this process is a registry slot, not a local
// decision: `forkWiring` in process-registry.mjs states the first-writer-wins
// policy that keeps a child engine on the parent's tree.
import { getProcessRegistry } from "../host/process-registry.mjs";

/**
 * The capability bag the core package sees. Every entry reads a host shape and
 * returns a plain value; the core never receives `pi` or a host context.
 *
 * This is production wiring, not a test double: it must name the same keys the
 * core contract declares. `session.agent` returns the host's agent identity
 * object (`{ kind, id, depth }`), never its id string; a station classifies a
 * session from the object. `fork.identityForAgent` is deliberately absent: the
 * core owns that lookup, and a host copy would be a second registry.
 */
export function createHostBag(pi, getEngine = () => null) {
  	const tools = createToolGateway(getEngine);
	return Object.freeze({
		session: Object.freeze({
			managerOf,
			conversationKey: conversationKeyOf,
			branch: branchOf,
			agent: (ctx) => ctx?.agent ?? null,
			canRewindRoot: (ctx) => canRewindRoot(pi, ctx),
			header: contextHeaderOf,
			setMessages: setAgentMessages,
			appendHistory: appendHistoryMessage,
  			// The approval mode comes from the session's own settings; the reading
  			// lives in the adapter, which owns every host shape.
  			settingsOf: settingsFor,
			abort: (ctx, error) => sessionFor(ctx)?.agent?.abort?.(error),
		}),
		model: Object.freeze({
			of: modelOf,
			thinkingOf,
			parseSpec: preparseModelSpec,
			capabilities,
			// The host's model facade lives on the extension context. The core
			// treats `ctx` as opaque, so the host hands it over as a reader.
			query: (ctx) => ctx?.models ?? null,
		}),
		accounting: Object.freeze({
			usage: Object.freeze({ entryUsage, totalInput, usageSnapshot }),
			pricing: Object.freeze({ charsToTokens, emptyCatalog: createEmptyCatalog }),
		}),
		fork: Object.freeze({
			// Getter with an optional setter: the core creates the one wiring
			// and stores it here, so a child engine reuses the parent's registry,
			// ledger, and waiters. The first wiring wins.
			wiring: getProcessRegistry().forkWiring,
			agentIdOf,
			sameManager,
		}),
		report: Object.freeze({ record }),
		// The host's tool surface. `listSpecs` feeds the static `.d.ts` block and
		// `execute` is the js ticket's inner funnel; both reach the tools that
		// confiscation hid from the model but kept alive. Exactly these two keys
		// form the contract, so the bag carries no extra surface here.
		tools: Object.freeze({
			listSpecs: (ctx) => tools.listSpecs(ctx),
			execute: (name, callId, args, signal, onUpdate, ctx) =>
				tools.execute(name, callId, args, signal, onUpdate, ctx),
		}),
	});
}

export function wireExtension(pi, pricingCatalog, diagnosis = null, env = process.env) {
	// The engine owns port resolution, fork wiring, the tool catalog, and the
	// scope read model. This function only supplies host facts and binds the
	// host's own surfaces.
	let engine = null;
	const refreshStationUI = (station, ctx) => {
		refreshStationDisplay(station, ctx, engine.forkWiring());
	};
	const attachStation = (station, ctx) => {
		const forkWiring = engine.forkWiring();
		// A station must leave this hook with its ports bound, even when the
		// host binding cannot be derived yet (no UI, no captured session). A
		// refused binding is recorded and the refresh path retries; leaving the
		// station unbound would make every later access report a missing port.
		let binding = null;
		try {
			binding = resolveStationBinding(station, ctx, forkWiring, {
				stationFor: (childCtx) => engine.station(childCtx),
				refresh: attachStation,
				abortChild: abortChildSession,
				interruptChild: interruptChildSession,
			});
		} catch (error) {
			record("activation", error, { phase: "station-binding" });
		}
		forkWiring.bind(station, binding ?? { display: null });
	};
	const hostBag = createHostBag(pi, () => engine);
	engine = createEngine({
		host: {
			...hostBag,
			fork: Object.freeze({
				...hostBag.fork,
				attachStation,
				refreshStation: refreshStationUI,
			}),
		},
		tickets: buildTickets(pi, (ctx) => engine?.station?.(ctx) ?? null),
		env,
		pricingCatalog,
	});
	bindScopeView(engine.scopes);
	registerProcessUserAbortEngine(engine);
	// Hide the host's own tools before the first request is assembled: from
	// this point `js` is the only tool the model can see, and everything else
	// is reachable only through the `api` object the ticket builds.
	installToolConfiscation(pi, () => engine);
	const hooks = wireHooks(pi, engine);
	for (const tool of engine.tools) pi.registerTool(tool);
	wireCommands(pi, engine);
	wireHostDiagnosis(pi, diagnosis, hooks);
	// The root needs the resolved table to decide whether the status widget
	// exists at all; the decision stays here, not in the host renderer.
	return { hooks, ports: engine.ports, engine };
}
