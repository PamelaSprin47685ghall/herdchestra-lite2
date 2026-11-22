// Build the implementation objects a station consumes.
//
// `resolvePorts` remains the only switch decision; this module turns each
// resolved name into the object the domain calls. Every port that needs state
// or behaviour is on the object path; `names` keeps the resolved name for
// reporting and domain checks. Do not invent a second table here.

import { resolvePorts } from "herdchestra-lite2";
import { createAmendOff, createAmendOn } from "herdchestra-lite2";
import { createHerdOff, createHerdOn } from "herdchestra-lite2";
import { createPinOff, createPinOn } from "herdchestra-lite2";
import { relayImplementations } from "herdchestra-lite2";
import { createClockOff, createClockOn } from "herdchestra-lite2";

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
		clock: names.clock === "off" ? createClockOff() : createClockOn(),
		relay: relayImplementations[names.relay],
		pin: {
			name: names.pin,
			bindState(store) {
				return names.pin === "off" ? createPinOff() : createPinOn({ notes: store.pins });
			},
		},
		amend: {
			name: names.amend,
			bindState(store) {
				return names.amend === "off"
					? createAmendOff()
					: createAmendOn({ retired: store.amends });
			},
		},
		herd: {
			name: names.herd,
			bindState(store) {
				return names.herd === "off" ? createHerdOff() : createHerdOn(store);
			},
		},
	};
	// One table, built once. Freezing the bundle and the binders keeps a
	// consumer from replacing an implementation behind the resolved switch.
	for (const port of ["pin", "amend", "herd"]) {
		Object.freeze(implementations[port]);
	}
	return {
		ok: true,
		names: Object.freeze(names),
		implementations: Object.freeze(implementations),
	};
}
