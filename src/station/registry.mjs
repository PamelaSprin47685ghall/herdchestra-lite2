// Station registry: one station per session manager, plus the active registry.

import { SessionStation } from "./station.mjs";

const nullTickets = {
	steer: () => {},
	canSteer: false,
	contextHandoff: (station, ctx, messages) => station.transformContext(messages, ctx),
	sessionStop: (station, ctx) => undefined,
	activateTools: (activeTools, prompt, changed) =>
		changed ? { systemPrompt: prompt } : undefined,
};

export function createStationRegistry(pi, tickets = nullTickets, pricingCatalog) {
	const stations = new WeakMap();
	let orphanStation = null;
	let pendingStation = null;

	const registry = {
		stationFor(ctx) {
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
			if (pendingStation?.state.relay?.handoffPending) return pendingStation;
			return station;
		},
		markPending(station) {
			pendingStation = station;
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
