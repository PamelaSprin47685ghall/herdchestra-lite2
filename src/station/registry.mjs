// Station registry: one station per session manager, plus the active registry.

import { SessionStation } from "./station.mjs";

const nullTickets = {
	steer: () => {},
	canSteer: false,
	activateTools: (activeTools, prompt, changed) =>
		changed ? { systemPrompt: prompt } : undefined,
};

export function createStationRegistry(pi, tickets = nullTickets, pricingCatalog) {
	const stations = new WeakMap();
	const flows = new WeakMap();
	let orphanStation = null;
	let pendingStation = null;

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
		// The host must explicitly bind each agent; a shared manager is not a
		// flow identity. Unbound callers retain the existing session path.
		bindFlow(agent, station, permission) {
			if (!agent || (typeof agent !== "object" && typeof agent !== "function")) throw new TypeError("Flow agent is required");
			if (!station || (permission !== "ro" && permission !== "rw")) throw new TypeError("Flow station and permission are required");
			if (flows.has(agent) || station.fissionFlow) throw new Error("Flow is already bound");
			station.fissionFlow = { agent, permission };
			flows.set(agent, station);
		},
		unbindFlow(agent) {
			const station = flows.get(agent);
			if (station?.fissionFlow?.agent === agent) delete station.fissionFlow;
			flows.delete(agent);
		},
		stationFor(ctx) {
			const agent = ctx?.agent;
			if (agent && flows.has(agent)) return flows.get(agent);
			const key = ctx?.sessionManager ?? ctx;
			if (!key || (typeof key !== "object" && typeof key !== "function")) {
				if (!orphanStation) {
					orphanStation = new SessionStation(null, pi, tickets, registry, pricingCatalog);
				}
				return orphanStation;
			}
			let station = stations.get(key);
			if (!station) {
				station = new SessionStation(ctx?.sessionManager ?? null, pi, tickets, registry, pricingCatalog);
				stations.set(key, station);
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

let activeRegistry = null;
let fallbackRegistry = null;

export function setActiveRegistry(registry) {
	activeRegistry = registry;
}

export function stationFor(ctx) {
	if (!activeRegistry) {
		if (!fallbackRegistry) fallbackRegistry = createStationRegistry(null);
		return fallbackRegistry.stationFor(ctx);
	}
	return activeRegistry.stationFor(ctx);
}

/** Alias kept for test compatibility: returns the SessionStation for ctx. */
export function stateFor(ctx) {
	return stationFor(ctx);
}
