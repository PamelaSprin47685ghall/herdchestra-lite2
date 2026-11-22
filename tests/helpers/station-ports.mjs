// Test station factory: production stations take a complete port bundle from
// the composition root. Tests that pass names only (or no wiring at all) get a
// bundle built by the same `buildPorts` the extension uses, so there is no
// second factory in src/.

import { buildPorts } from "../../src/activation/ports.mjs";
import { PORT_NAMES } from "../../src/core/ports/registry.mjs";
import { IMPLEMENTATION_KEYS } from "../../src/station/ports-contract.mjs";

const ENV_NAME = {
	pin: "HERD_PIN",
	amend: "HERD_AMEND",
	herd: "HERD_HERD",
	clock: "HERD_CLOCK",
	folding: "HERD_FOLDING",
	relay: "HERD_RELAY",
};

function implementationsComplete(implementations) {
	return (
		implementations &&
		typeof implementations === "object" &&
		IMPLEMENTATION_KEYS.every((key) => implementations[key])
	);
}

function tableComplete(table) {
	return (
		table &&
		typeof table === "object" &&
		PORT_NAMES.every((name) => typeof table[name] === "string")
	);
}

function builtFor(names, env = {}) {
	const switches = { ...env };
	for (const [port, key] of Object.entries(ENV_NAME)) {
		if (typeof names?.[port] === "string") switches[key] = names[port];
	}
	const built = buildPorts(switches);
	if (!built.ok) throw new Error(built.detail);
	return built;
}

/**
 * Bind the production bundle to a plain state object, for prototype-based
 * station doubles that cannot run the constructor. Same table as production.
 */
export function bindStationPorts(state, env = {}) {
	const implementations = builtFor(null, env).implementations;
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
 * carries both the full implementation bundle and the full name table passes
 * through unchanged (identity assertions stay valid); a partial or names-only
 * double is completed from the same switches.
 */
export function createTestStation(Station, manager, pi, tickets, wiring, pricing) {
	const providedTable = wiring?.ports?.() ?? null;
	const providedImplementations = wiring?.implementations?.() ?? null;
	if (
		implementationsComplete(providedImplementations) &&
		tableComplete(providedTable)
	) {
		return new Station(manager, pi, tickets, wiring, pricing);
	}
	const built = builtFor(providedTable);
	const names = Object.freeze({ ...built.names, ...(providedTable ?? {}) });
	const implementations = Object.freeze({
		...built.implementations,
		...(providedImplementations ?? {}),
	});
	const registry = {
		...(wiring ?? {}),
		ports: () => names,
		implementations: () => implementations,
	};
	return new Station(manager, pi, tickets, registry, pricing);
}
