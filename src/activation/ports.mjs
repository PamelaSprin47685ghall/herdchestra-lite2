// Build the implementation objects a station consumes.
//
// `resolvePorts` remains the only switch decision; this module turns each
// resolved name into the object the domain calls. Folding and clock are the
// first two ports on the object path. A port that has no object yet stays a
// name in `names`; do not invent a second table here.

import { resolvePorts } from "../core/ports/resolve.mjs";
import { foldingOff, foldingOn } from "../features/folding/index.mjs";
import { createClockOff, createClockOn } from "../scope/clock.mjs";

function detailOf(refusal) {
	const available = Array.isArray(refusal.available) ? refusal.available.join(", ") : "";
	return `the port switch is unusable: ${refusal.code} port=${refusal.port} wanted=${refusal.wanted ?? "default"} available=[${available}]`;
}

/**
 * Resolve once and build the objects bound to this station.
 *
 * A refusal is data with both sides named. The caller records it and refuses
 * to start; a half-built table would wire a different system.
 */
export function buildPorts(env = process.env) {
	const resolved = resolvePorts({}, env);
	if (!resolved.ok) {
		return { ...resolved, detail: detailOf(resolved), names: {}, implementations: {} };
	}
	const names = { ...resolved.ports };
	const implementations = {
		folding: names.folding === "off" ? foldingOff() : foldingOn(),
		clock: names.clock === "off" ? createClockOff() : createClockOn(),
	};
	return { ok: true, names, implementations };
}
