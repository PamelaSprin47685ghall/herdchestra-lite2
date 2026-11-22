// Station registry: one station per session manager, plus the active registry.

import { attachForkPorts, createForkWiring } from "../host/fork-wiring.mjs";
import { conversationKeyOf, ledgerFor } from "../host/fork-registry.mjs";
import { SessionStation } from "./station.mjs";

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

const nullTickets = {
	steer: () => {},
	canSteer: false,
	activateTools: (activeTools, prompt, changed) =>
		changed ? { systemPrompt: prompt } : undefined,
};

export function createStationRegistry(pi, tickets = nullTickets, pricingCatalog, ports = {}) {
	// The resolved port table, decided once by the composition root. Domain code
	// reads this instead of asking a switch, so there is exactly one place where
	// "which implementation" is answered.
	let resolvedPorts = { ...ports };
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
		try {
			attachForkPorts(station, forkWiring, {
				conversationKey: conversationKeyOf(ctx?.sessionManager ?? station.manager ?? null),
				...(ports.forkOptions ?? {}),
			});
		} catch (error) {
			// A station without ports still works: every fork call reports the
			// missing capability instead of inventing a ledger.
			station.noteError?.("fork", error);
		}
		ports.onStation?.(station, ctx ?? null);
	}

	// The pending handoff belongs to one session. A `/new` or a session switch
	// must never route the next stop to the old station.
	function sameManager(station, ctx) {
		const key = ctx?.sessionManager ?? ctx;
		if (!key || !station?.manager) return false;
		if (station.manager === key) return true;
		try {
			const live = key.getSessionId?.();
			const armed = station.manager.getSessionId?.();
			return Boolean(live && armed && live === armed);
		} catch {
			return false;
		}
	}

	const registry = {
		/** The port table chosen at startup; null until the wiring resolves it. */
		setPorts(table) {
			if (table === null || typeof table !== "object") {
				throw new TypeError("setPorts() expects the resolved port table");
			}
			resolvedPorts = { ...table };
			return resolvedPorts;
		},
		ports() {
			return { ...resolvedPorts };
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
				ports.onStationRefresh?.(station, ctx ?? null);
			} catch (error) {
				station.noteError?.("activation", error);
			}
			return station;
		},
		stationForStop(ctx) {
			const station = registry.stationFor(ctx);
			if (station.state.relay?.handoffPending) return station;
			if (!pendingStation) return station;
			if (!sameManager(pendingStation, ctx)) {
				pendingStation = null;
				return station;
			}
			if (pendingStation.state.relay?.handoffPending) return pendingStation;
			return station;
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
