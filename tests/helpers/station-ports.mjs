// Test station factory: production stations take a complete port bundle from
// the composition root. Tests that pass names only (or no wiring at all) get a
// bundle built by the same `buildPorts` the extension uses, so there is no
// second factory in src/.

import { buildPorts } from "../../src/activation/ports.mjs";
import { IMPLEMENTATION_KEYS } from "../../src/station/ports-contract.mjs";

const ENV_NAME = {
	pin: "HERD_PIN",
	amend: "HERD_AMEND",
	herd: "HERD_HERD",
	clock: "HERD_CLOCK",
	folding: "HERD_FOLDING",
	relay: "HERD_RELAY",
};

function complete(implementations) {
	return (
		implementations &&
		typeof implementations === "object" &&
		IMPLEMENTATION_KEYS.every((key) => implementations[key])
	);
}

function bundleFor(names, env = {}) {
	const switches = { ...env };
	for (const [port, key] of Object.entries(ENV_NAME)) {
		if (typeof names?.[port] === "string") switches[key] = names[port];
	}
	const built = buildPorts(switches);
	if (!built.ok) throw new Error(built.detail);
	return built.implementations;
}

/**
 * Bind the production bundle to a plain state object, for prototype-based
 * station doubles that cannot run the constructor. Same table as production.
 */
export function bindStationPorts(state, env = {}) {
	const implementations = bundleFor(null, env);
	return Object.freeze({
		relay: implementations.relay,
		clock: implementations.clock,
		folding: implementations.folding,
		pin: implementations.pin.bindState(state),
		amend: implementations.amend.bindState(state),
		herd: implementations.herd.bindState(state),
	});
}

/**
 * Construct a station with a complete bundle. A wiring double that already
 * carries the full bundle passes through unchanged (identity assertions stay
 * valid); a names-only double is completed from the same switches.
 */
export function createTestStation(Station, manager, pi, tickets, wiring, pricing) {
	let registry = wiring;
	if (!complete(registry?.implementations?.())) {
		const names = registry?.ports?.() ?? null;
		const provided = registry?.implementations?.() ?? {};
		const implementations = Object.freeze({
			...bundleFor(names),
			...provided,
		});
		registry = { ...(registry ?? {}), implementations: () => implementations };
	}
	return new Station(manager, pi, tickets, registry, pricing);
}
