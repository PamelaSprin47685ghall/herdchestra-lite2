// Station registry: one station per session manager, plus the active registry.

import { PORT_NAMES } from "../core/ports/registry.mjs";
import { identityForAgent } from "../scope/fork-registry.mjs";
import { SessionStation } from "./station.mjs";
import { IMPLEMENTATION_KEYS, missingPortsError } from "./ports-contract.mjs";

/**
 * The registry takes the grouped `host` shape. A test double written against
 * the older flat bag is widened here, in one place, so no station carries a
 * second convention.
 */
function normalizeHost(host) {
	const source = host && typeof host === "object" ? host : {};
	if (source.session && source.report) return source;
	const session = Object.freeze({
		managerOf: source.managerOf,
		conversationKey: source.conversationKeyOf,
		branch: source.branchOf,
		agent: source.agentOf,
		header: source.contextHeaderOf,
		setMessages: source.setAgentMessages,
		appendHistory: source.appendHistoryMessage,
		abort: (ctx, error) => source.sessionFor?.(ctx)?.agent?.abort?.(error),
		canRewindRoot: source.canRewindRoot,
	});
	const model = Object.freeze({
		of: source.modelOf,
		thinkingOf: source.thinkingOf,
		parseSpec: source.preparseModelSpec,
		capabilities: source.capabilities,
	});
	return Object.freeze({
		session,
		model,
		accounting: Object.freeze({
			usage: source.usage,
			pricing: source.pricing && {
				...source.pricing,
				emptyCatalog: source.createEmptyCatalog,
			},
		}),
		fork: Object.freeze({
			wiring: source.forkWiring,
			attachBaseForkPorts: source.attachBaseForkPorts,
			identityForAgent: source.identityForAgent,
			agentIdOf: source.agentIdOf,
			sameManager: source.sameManager,
			ledgerFor: source.ledgerFor,
			adoptLedger: source.adoptLedger,
		}),
		report: Object.freeze({ record: source.record }),
	});
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
		features: source.features,
		onStation: source.onStation,
		onStationRefresh: source.onStationRefresh,
		forkOptions: source.forkOptions,
	};
}

/**
 * Build the one registry for an extension instance.
 *
 * `host` is a plain capability bag supplied by the composition root. It is the
 * only place where this module meets a concrete host: the registry imports no
 * host module, and every capability is optional so a hostless station still
 * reports the missing capability instead of failing the hook.
 */
export function createStationRegistry(options = {}) {
	const { tickets, pricingCatalog = null } = options;
	const host = normalizeHost(options.host);
	const defaultAgentId = () => null;
	if (
		!tickets ||
		typeof tickets.steer !== "function" ||
		typeof tickets.prompt !== "function"
	) {
		const error = new Error(
			"MISSING_TICKETS: createStationRegistry requires steer/prompt",
		);
		error.code = "MISSING_TICKETS";
		throw error;
	}
	const wiring = readWiring(options);
	// The resolved port table, decided once by the composition root. Domain code
	// reads this instead of asking a switch, so there is exactly one place where
	// "which implementation" is answered. Implementations are the object form of
	// the same decision for the ports that have one.
	const resolvedPorts = wiring.table;
	const resolvedImplementations = wiring.implementations;
	const resolvedFeatures = Object.freeze({
		values: Object.freeze({ ...(wiring.features?.values ?? {}) }),
		explicit: Object.freeze({ ...(wiring.features?.explicit ?? {}) }),
	});
	const stations = new WeakMap();
	let orphanStation = null;
	// One fork tree per process; the ledger is chosen by conversation, so a
	// parent and its children share brackets even though they are different
	// stations in different agents.
	// The fork tree outlives one extension instance. The host owns the process
	// singleton because it is a host-lifecycle fact, not a station fact.
	const forkWiring = options.forkWiring ?? host.fork?.wiring?.() ?? null;

	/**
	 * Give a freshly built station its fork ports, then let the composition
	 * root do its own work. The ports are attached here rather than inside the
	 * constructor because the conversation key is the manager, which only the
	 * registry sees.
	 */
	function attachStationPorts(station, ctx) {
		const identity = (host.fork?.identityForAgent ?? identityForAgent)(
			forkWiring?.registry,
			(host.fork?.agentIdOf ?? defaultAgentId)(ctx),
		);
		try {
			host.fork?.attachBaseForkPorts?.(station, forkWiring, {
				identity,
				conversationKey: host.session?.conversationKey?.(
					host.session?.managerOf?.(ctx) ?? station.manager ?? null,
				),
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
		/** The startup feature values and the explicit environment subset. */
		features() {
			return resolvedFeatures;
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
			return host;
		},
		/**
		 * The process-wide fork wiring. A station takes its ledger from here so
		 * every agent of one conversation pairs brackets against the same tree.
		 */
		forkWiring() {
			return forkWiring;
		},
		hasStation(ctx) {
			const key = host.session?.managerOf?.(ctx) ?? ctx ?? null;
			if (!key || (typeof key !== "object" && typeof key !== "function")) {
				return orphanStation !== null;
			}
			return stations.has(key);
		},
		stationFor(ctx) {
			const key = host.session?.managerOf?.(ctx) ?? ctx ?? null;
			if (!key || (typeof key !== "object" && typeof key !== "function")) {
				if (!orphanStation) {
					orphanStation = new SessionStation(null, host, tickets, registry, pricingCatalog);
					// The composition root may attach ports the moment a station
					// exists. The hook carries no policy: it only hands the
					// station over once.
					attachStationPorts(orphanStation, ctx ?? null);
				}
				return orphanStation;
			}
			let station = stations.get(key);
			if (!station) {
				station = new SessionStation(
					host.session?.managerOf?.(ctx) ?? null,
					host,
					tickets,
					registry,
					pricingCatalog,
				);
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
	};

	return registry;
}

// The registry is owned by the activation wiring that created it. A module
// singleton would be a second, process-wide owner of station state.
