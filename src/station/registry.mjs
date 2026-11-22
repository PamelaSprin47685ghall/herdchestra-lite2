// Station registry: one station per session manager, plus the active registry.

import { attachBaseForkPorts, createForkWiring } from "../host/fork-wiring.mjs";
import {
	adoptLedger,
	agentIdOf,
	conversationKeyOf,
	identityForAgent,
	ledgerFor,
	selectStopStation,
} from "../host/fork-registry.mjs";
import { capabilities, contextHeaderOf, modelOf, thinkingOf } from "../host/adapter.mjs";
import { appendHistoryMessage } from "../host/hack-context.mjs";
import { sessionFor, setAgentMessages } from "../host/capture.mjs";
import { record } from "../host/diagnostics.mjs";
import { createEmptyCatalog, preparseModelSpec } from "../host/pricing.mjs";
import { PORT_NAMES } from "../core/ports/registry.mjs";
import { SessionStation } from "./station.mjs";
import { IMPLEMENTATION_KEYS, missingPortsError } from "./ports-contract.mjs";

/**
 * One fork registry per process. A fork tree spans agents, and every agent
 * loads the extension again, so the wiring must outlive one extension
 * instance.
 */
const FORK_WIRING_KEY = Symbol.for("herdchestra-lite2.fork-wiring.v1");

function globalForkWiring() {
	let wiring = globalThis[FORK_WIRING_KEY];
	if (!wiring) {
		wiring = createForkWiring();
		Object.defineProperty(globalThis, FORK_WIRING_KEY, {
			value: wiring,
			enumerable: false,
			configurable: true,
		});
	}
	return wiring;
}

/**
 * Read the one wiring shape the composition root sends:
 * `{ ports, implementations, onStation, onStationRefresh, forkOptions }`.
 * A flat name table is refused instead of silently read as an empty one.
 */
function completeBundle(implementations) {
	if (
		!implementations ||
		typeof implementations !== "object" ||
		Array.isArray(implementations)
	) {
		throw missingPortsError([...IMPLEMENTATION_KEYS]);
	}
	const missing = IMPLEMENTATION_KEYS.filter((key) => !implementations[key]);
	if (missing.length > 0) throw missingPortsError(missing);
	return Object.freeze({ ...implementations });
}

function readWiring(input) {
	const source = input && typeof input === "object" ? input : {};
	if (PORT_NAMES.some((name) => Object.hasOwn(source, name))) {
		const error = new TypeError(
			"LEGACY_PORTS_SHAPE: pass { ports, implementations, ... }, not a flat name table",
		);
		error.code = "LEGACY_PORTS_SHAPE";
		throw error;
	}
	const table = Object.freeze(
		source.ports && typeof source.ports === "object" && !Array.isArray(source.ports)
			? { ...source.ports }
			: {},
	);
	const implementations = completeBundle(source.implementations);
	return {
		table,
		implementations,
		onStation: source.onStation,
		onStationRefresh: source.onStationRefresh,
		forkOptions: source.forkOptions,
	};
}

export function createStationRegistry(pi, tickets, pricingCatalog, ports = {}) {
	if (
		!tickets ||
		typeof tickets.activateTools !== "function" ||
		typeof tickets.steer !== "function" ||
		typeof tickets.prompt !== "function"
	) {
		const error = new Error(
			"MISSING_TICKETS: createStationRegistry requires activateTools/steer/prompt",
		);
		error.code = "MISSING_TICKETS";
		throw error;
	}
	const wiring = readWiring(ports);
	// The resolved port table, decided once by the composition root. Domain code
	// reads this instead of asking a switch, so there is exactly one place where
	// "which implementation" is answered. Implementations are the object form of
	// the same decision for the ports that have one.
	const resolvedPorts = wiring.table;
	const resolvedImplementations = wiring.implementations;
	const stations = new WeakMap();
	let orphanStation = null;
	let pendingStation = null;
	// One fork tree per process; the ledger is chosen by conversation, so a
	// parent and its children share brackets even though they are different
	// stations in different agents.
	const forkWiring = globalForkWiring();

	/**
	 * Give a freshly built station its fork ports, then let the composition
	 * root do its own work. The ports are attached here rather than inside the
	 * constructor because the conversation key is the manager, which only the
	 * registry sees.
	 */
	function attachStationPorts(station, ctx) {
		const identity = identityForAgent(forkWiring.registry, agentIdOf(ctx));
		try {
			attachBaseForkPorts(station, forkWiring, {
				identity,
				conversationKey: conversationKeyOf(ctx?.sessionManager ?? station.manager ?? null),
				...(wiring.forkOptions ?? {}),
			});
		} catch (error) {
			// A station without ports still works: every fork call reports the
			// missing capability instead of inventing a ledger.
			station.noteError?.("fork", error);
		}
		try {
			wiring.onStation?.(station, ctx ?? null);
		} catch (error) {
			// The host binding is a capability like the ports: a station without
			// it still works and reports the failure instead of failing the hook.
			station.noteError?.("activation", error);
		}
	}

	const registry = {
		/** The one frozen table chosen at startup; every reader shares it. */
		ports() {
			return resolvedPorts;
		},
		/** Object implementations for the ports that have one; frozen once. */
		implementations() {
			return resolvedImplementations;
		},
		/**
		 * Host capabilities for the Station. The Station imports no host module;
		 * the registry is the one composition bridge that can see them.
		 */
		host() {
			return {
				conversationKeyOf,
				ledgerFor,
				adoptLedger,
				sessionFor,
				setAgentMessages,
				contextHeaderOf,
				record,
				createEmptyCatalog,
				appendHistoryMessage,
				preparseModelSpec,
				capabilities,
				modelOf,
				thinkingOf,
			};
		},
		/**
		 * The process-wide fork wiring. A station takes its ledger from here so
		 * every agent of one conversation pairs brackets against the same tree.
		 */
		forkWiring() {
			return globalForkWiring();
		},
		stationFor(ctx) {
			const key = ctx?.sessionManager ?? ctx;
			if (!key || (typeof key !== "object" && typeof key !== "function")) {
				if (!orphanStation) {
					orphanStation = new SessionStation(null, pi, tickets, registry, pricingCatalog);
					// The composition root may attach ports the moment a station
					// exists. The hook carries no policy: it only hands the
					// station over once.
					attachStationPorts(orphanStation, ctx ?? null);
				}
				return orphanStation;
			}
			let station = stations.get(key);
			if (!station) {
				station = new SessionStation(ctx?.sessionManager ?? null, pi, tickets, registry, pricingCatalog);
				stations.set(key, station);
				attachStationPorts(station, ctx ?? null);
				return station;
			}
			// A station is cached for the whole session. Its first attach may
			// have run before the interactive UI existed (or before the host
			// session was remembered), and a display snapshot would then stay
			// null forever. Give the composition root a cheap refresh every time
			// the station is reached; the refresh only fills missing UI state.
			try {
				wiring.onStationRefresh?.(station, ctx ?? null);
			} catch (error) {
				station.noteError?.("activation", error);
			}
			return station;
		},
		stationForStop(ctx) {
			const station = registry.stationFor(ctx);
			const selected = selectStopStation({ station, pendingStation, ctx });
			if (selected.clearPending) pendingStation = null;
			return selected.station;
		},
		markPending(station) {
			pendingStation = station;
		},
		clearPending(station) {
			if (!station || pendingStation === station) pendingStation = null;
		},
	};

	return registry;
}

// The registry is owned by the activation wiring that created it. A module
// singleton would be a second, process-wide owner of station state.
