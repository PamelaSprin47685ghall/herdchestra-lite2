/**
 * Activation domain index: assemble the extension from stations, hooks, and
 * tools. Mechanical only. No business logic lives here.
 */

import { createEngine } from "herdchestra-lite2";
import { agentIdOf, conversationKeyOf, sameManager, selectStopStation } from "../host/identity-adapters.mjs";
import {
	capabilities,
	contextHeaderOf,
	managerOf,
	modelOf,
	thinkingOf,
} from "../host/adapter.mjs";
import { appendHistoryMessage } from "../host/hack-context.mjs";
import { sessionFor, setAgentMessages } from "../host/capture.mjs";
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
import { stopAfterScopeReturn } from "../host/branch-context.mjs";

export { installCapture };

/**
 * One fork wiring per process. A fork tree spans agents, and the host binds
 * the extension again for every child session, so the wiring must outlive one
 * engine. The core creates the object; this slot keeps it. Using one registry
 * here is also what keeps every scope on the same ledger and the same shared
 * journal: a per-engine wiring would give each child its own tree.
 */
const FORK_WIRING_KEY = Symbol.for("herdchestra-lite2.fork-wiring.v1");

function globalForkWiring(wiring = null) {
	if (wiring && !globalThis[FORK_WIRING_KEY]) {
		Object.defineProperty(globalThis, FORK_WIRING_KEY, {
			value: wiring,
			enumerable: false,
			configurable: true,
		});
	}
	return globalThis[FORK_WIRING_KEY] ?? null;
}

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
export function createHostBag(pi) {
	const branchOf = (ctx) => {
		try {
			const branch = managerOf(ctx)?.getBranch?.();
			return Array.isArray(branch) ? branch : [];
		} catch {
			return [];
		}
	};
	const activeTools = () => {
		try {
			const active = pi?.getActiveTools?.();
			return Array.isArray(active) ? active : [];
		} catch {
			return [];
		}
	};
	return Object.freeze({
		session: Object.freeze({
			managerOf,
			conversationKey: conversationKeyOf,
			branch: branchOf,
			agent: (ctx) => ctx?.agent ?? null,
			activeTools,
			header: contextHeaderOf,
			setMessages: setAgentMessages,
			appendHistory: appendHistoryMessage,
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
			wiring: globalForkWiring,
			agentIdOf,
			selectStopStation,
			sameManager,
		}),
		report: Object.freeze({ record }),
	});
}

export function wireExtension(
	pi,
	pricingCatalog,
	diagnosis = null,
	env = process.env,
	sharedFirstTurn = null,
) {
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
				stopAfterReturn: (agent) => stopAfterScopeReturn(agent),
			});
		} catch (error) {
			record("activation", error, { phase: "station-binding" });
		}
		forkWiring.bind(station, binding ?? { display: null });
	};
	const hostBag = createHostBag(pi);
	engine = createEngine({
		host: {
			...hostBag,
			fork: Object.freeze({
				...hostBag.fork,
				attachStation,
				refreshStation: refreshStationUI,
			}),
		},
		tickets: buildTickets(pi),
		env,
		pricingCatalog,
	});
	bindScopeView(engine.scopes);
	const hooks = wireHooks(pi, engine, sharedFirstTurn);
	for (const tool of engine.tools) pi.registerTool(tool);
	wireCommands(pi, engine);
	wireHostDiagnosis(pi, diagnosis, hooks);
	// The root needs the resolved table to decide whether the status widget
	// exists at all; the decision stays here, not in the host renderer.
	return { hooks, ports: engine.ports, engine };
}
