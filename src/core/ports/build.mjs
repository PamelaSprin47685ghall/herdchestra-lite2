// Build the implementation objects a station consumes.
//
// `resolvePorts` remains the only switch decision; this module turns each
// resolved name into the object the domain calls. Every port that needs state
// or behaviour is on the object path; `names` keeps the resolved name for
// reporting and domain checks. Do not invent a second table here.

import { resolvePorts } from "./resolve.mjs";
import { createHerdOff, createHerdOn } from "../../features/herd/index.mjs";
import { parseFeatureEnv } from "../../features/herd/features.mjs";
import { createClockOff, createClockOn } from "../../scope/clock.mjs";

function detailOf(refusal) {
	const available = Array.isArray(refusal.available) ? refusal.available.join(", ") : "";
	return `the port switch is unusable: ${refusal.code} port=${refusal.port} wanted=${refusal.wanted ?? "default"} available=[${available}]`;
}

function featureDetailOf(refusal) {
	const available = Array.isArray(refusal.available) ? refusal.available.join(", ") : "";
	return `the feature switch is unusable: ${refusal.code} feature=${refusal.feature} wanted=${refusal.wanted} available=[${available}]`;
}

/**
 * Resolve once and build the objects bound to this station.
 *
 * A refusal is data with both sides named. The caller records it and refuses
 * to start; a half-built table would wire a different system.
 */
export function buildPorts(env = process.env) {
	const features = parseFeatureEnv(env);
	if (!features.ok) {
		return {
			...features,
			detail: featureDetailOf(features),
			names: {},
			implementations: {},
		};
	}
	const resolved = resolvePorts({}, env);
	if (!resolved.ok) {
		return { ...resolved, detail: detailOf(resolved), names: {}, implementations: {} };
	}
	const names = { ...resolved.ports };
	const implementations = {
		clock: names.clock === "off" ? createClockOff() : createClockOn(),
		herd: {
			name: names.herd,
			bindState(store) {
				return names.herd === "off" ? createHerdOff() : createHerdOn(store);
			},
		},
	};
	for (const port of ["herd"]) {
		Object.freeze(implementations[port]);
	}
	return {
		ok: true,
		names: Object.freeze(names),
		implementations: Object.freeze(implementations),
		features: Object.freeze({
			values: Object.freeze({ ...features.values }),
			explicit: Object.freeze({ ...features.explicit }),
		}),
	};
}
