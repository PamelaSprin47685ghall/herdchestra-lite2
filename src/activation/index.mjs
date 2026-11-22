/**
 * Activation domain index: assemble the extension from stations, hooks, and
 * tools. Mechanical only. No business logic lives here.
 */

import { createStationRegistry } from "../station/index.mjs";
import { bindHostForkPorts } from "../host/fork-wiring.mjs";
import {
	refreshStationDisplay,
	resolveStationBinding,
} from "../host/activation-binding.mjs";
import { buildPorts } from "./ports.mjs";

import { record } from "../host/diagnostics.mjs";
import { wireCommands } from "./commands.mjs";
import { wireHostDiagnosis } from "./diagnosis.mjs";
import { buildTickets } from "./tickets.mjs";
import { installCapture } from "./capture.mjs";
import { wireHooks } from "./hooks.mjs";
import { wireTools } from "./tools.mjs";

export { installCapture };

/** Assemble the extension: registry, hooks, tools, and commands. */
/**
 * Resolve every port once, at startup, and hand the answer to the registry.
 *
 * This is the only place in the extension that reads a switch. A refusal here
 * is a configuration error with both sides named, so it is recorded and thrown
 * rather than quietly falling back: a half-resolved table would wire a
 * different system than the one the user asked for.
 */
export function resolveWiringPorts(env = process.env) {
	const built = buildPorts(env);
	if (built.ok) {
		return { ports: built.names, implementations: built.implementations };
	}
	record("activation", new Error(built.detail), { port: built.port });
	// Fail fast: an empty table would wire a different system than the one the
	// user asked for, and every port would answer with its fallback.
	const error = new Error(built.detail);
	error.code = built.code ?? "PORT_UNAVAILABLE";
	error.port = built.port;
	throw error;
}

export function wireExtension(pi, pricingCatalog, diagnosis = null, env = process.env) {
	const ports = resolveWiringPorts(env);
	const table = ports.ports;
	let registry = null;
	// The composition root refreshes only the UI seam. The host returns a
	// cached station before the interactive context exists; this fills the
	// display later without touching the ledger or the spawner.
	const refreshStationUI = (station, ctx) => {
		refreshStationDisplay(station, ctx, registry.forkWiring());
	};
	const attachStation = (station, ctx) => {
		const forkWiring = registry.forkWiring();
		const binding = resolveStationBinding(station, ctx, forkWiring, {
			stationFor: (childCtx) => registry.stationFor(childCtx),
			refresh: attachStation,
		});
		bindHostForkPorts(station, forkWiring, binding);
	};
	registry = createStationRegistry(pi, buildTickets(pi), pricingCatalog, {
		ports: table,
		implementations: ports.implementations,
		onStation: attachStation,
		onStationRefresh: refreshStationUI,
	});
	const hooks = wireHooks(pi, registry);
	wireTools(pi, registry);
	wireCommands(pi, registry);
	wireHostDiagnosis(pi, diagnosis, hooks);
	// The root needs the resolved table to decide whether the status widget
	// exists at all; the decision stays here, not in the host renderer.
	return { hooks, ports: table, registry };
}
