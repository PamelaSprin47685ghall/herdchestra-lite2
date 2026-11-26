// Port resolution: the composition root's only decision.
//
// Two questions, both answered before anything awaits:
//   1. Which implementation does this port take under this environment?
//   2. Do the implementations a ticket asked for exist and stay enabled?
//
// A refusal is data, not an exception: an unknown port, an unregistered
// implementation, or a conflict with an explicit environment choice all come
// back as PORT_UNAVAILABLE with the values that would have been accepted.
// Nothing is half-started by a typo.

import { PORTS, disableName, switchName } from "./registry.mjs";

const DISABLED_VALUES = new Set(["1", "true", "yes", "on"]);

/** An environment object, or the process environment when none is given. */
function environment(env) {
	if (env && typeof env === "object") return env;
	return typeof process === "object" && process?.env ? process.env : {};
}

function truthy(text) {
	return DISABLED_VALUES.has(String(text ?? "").trim().toLowerCase());
}

/**
 * What the environment says about one port.
 *
 * `explicit` separates "the user chose this" from "nothing said anything and
 * the fallback applies". A ticket may override a fallback, never an explicit
 * choice.
 */
export function readSwitch(port, env) {
	const entry = PORTS[port];
	if (!entry) return refusal(port, null, []);
	const source = environment(env);
	// The named switch wins over the legacy disable flag.
	const raw = source[switchName(port)];
	if (raw !== undefined && String(raw).trim() !== "") {
		const name = String(raw).trim();
		if (!entry.implementations.includes(name)) {
			return refusal(port, name, entry.implementations);
		}
		return { ok: true, implementation: name, explicit: true };
	}
	if (truthy(source[disableName(port)])) {
		return { ok: true, implementation: "off", explicit: true };
	}
	return { ok: true, implementation: entry.fallback, explicit: false };
}

/**
 * Resolve a ticket's `uses` map together with the environment.
 *
 * `uses` is data: `{ pin: "off" }`. A port not named in
 * `uses` takes its environment value. An explicit environment choice wins over
 * a ticket: asking for something else is refused rather than silently granted.
 */
export function resolvePorts(uses = {}, env) {
	if (uses !== undefined && uses !== null && (typeof uses !== "object" || Array.isArray(uses))) {
		return { ok: false, code: "INVALID_USES", detail: "uses must be a plain object" };
	}
	// A typo in `uses` must not be silently ignored: the ticket would then run
	// on the default implementation while believing it chose another.
	for (const port of Object.keys(uses ?? {})) {
		if (!Object.hasOwn(PORTS, port)) return refusal(port, uses[port], []);
	}
	const chosen = {};
	for (const port of Object.keys(PORTS)) {
		const setting = readSwitch(port, env);
		if (!setting.ok) return setting;
		if (!uses || !Object.hasOwn(uses, port)) {
			chosen[port] = setting.implementation;
			continue;
		}
		const wanted = uses[port];
		if (!PORTS[port].implementations.includes(wanted)) {
			return refusal(port, wanted, PORTS[port].implementations);
		}
		if (setting.explicit && setting.implementation !== wanted) {
			return refusal(port, wanted, [setting.implementation]);
		}
		chosen[port] = wanted;
	}
	return { ok: true, ports: chosen };
}

function refusal(port, wanted, available) {
	return {
		ok: false,
		code: "PORT_UNAVAILABLE",
		port,
		wanted: wanted ?? null,
		available: [...available],
	};
}
