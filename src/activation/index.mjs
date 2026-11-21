/**
 * Activation domain index: assemble the extension from stations, hooks, and
 * tools. Mechanical only. No business logic lives here.
 */

import { createStationRegistry, setActiveRegistry } from "../station/index.mjs";
import { resolvePorts } from "../core/ports/resolve.mjs";
import { record } from "../host/diagnostics.mjs";
import { wireCommands } from "./commands.mjs";
import { wireHostDiagnosis } from "./diagnosis.mjs";
import { wireFission } from "./fission.mjs";
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
	const resolved = resolvePorts({}, env);
	if (!resolved.ok) {
		const detail = `the port switch is unusable: ${resolved.code} port=${resolved.port} wanted=${resolved.wanted ?? "default"} available=[${resolved.available.join(", ")}]`;
		record("activation", new Error(detail), { port: resolved.port });
		return { ok: false, ...resolved, detail };
	}
	return resolved;
}

export function wireExtension(pi, pricingCatalog, diagnosis = null, env = process.env) {
	const ports = resolveWiringPorts(env);
	const registry = createStationRegistry(pi, buildTickets(pi), pricingCatalog, ports.ok ? ports.ports : {});
	if (!ports.ok) {
		record("activation", new Error(ports.detail), { wiring: "ports" });
	}
	setActiveRegistry(registry);
	const hooks = wireHooks(pi, registry);
	wireTools(pi, registry);
	wireCommands(pi, registry);
	const fission = wireFission(pi, registry);
	wireHostDiagnosis(pi, diagnosis, hooks);
	return { hooks, fission };
}
