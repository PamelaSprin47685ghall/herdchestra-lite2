// Test station factory: production stations take a complete port bundle from
// the composition root. Tests that pass names only (or no wiring at all) get a
// bundle built by the same `buildPorts` the extension uses, so there is no
// second factory in src/.

import { buildPorts } from "../../host-omp/src/activation/ports.mjs";
import { createForkWiring } from "../../host-omp/src/host/fork-wiring.mjs";
import { PORT_NAMES } from "../../src/core/ports/registry.mjs";
import { IMPLEMENTATION_KEYS } from "../../src/station/ports-contract.mjs";

/**
 * A station double still meets the two host facts the registry keys on: the
 * session manager behind a context, and the one fork tree per process. The
 * production composition root supplies both through its own bag.
 */
const testWiringKey = Symbol.for("herdchestra-lite2.test-fork-wiring.v1");

function testForkWiring() {
	let wiring = globalThis[testWiringKey];
	if (!wiring) {
		wiring = createForkWiring();
		Object.defineProperty(globalThis, testWiringKey, {
			value: wiring,
			enumerable: false,
			configurable: true,
		});
	}
	return wiring;
}

export const testHostBag = {
	managerOf: (ctx) => ctx?.sessionManager ?? null,
	forkWiring: () => testForkWiring(),
	branchOf: (ctx) => {
		try {
			const branch = ctx?.sessionManager?.getBranch?.();
			return Array.isArray(branch) ? branch : [];
		} catch {
			return [];
		}
	},
	agentOf: (ctx) => ctx?.agent ?? null,
	activeTools: () => [],
};

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
		host: () => ({ ...testHostBag, ...(wiring?.host?.() ?? {}) }),
		ports: () => names,
		implementations: () => implementations,
	};
	return new Station(manager, pi, tickets, registry, pricing);
}
