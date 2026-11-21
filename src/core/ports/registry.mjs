// Port registry: every workbench, the implementations it may take, and the
// default.
//
// A switch names an implementation of a port; it never says whether the port
// exists. Two-implementation ports use the names `on` and `off`, so the older
// boolean variable keeps one meaning. `scope` and `relay` carry three, and
// their names describe the shape or the obligation rather than a switch
// position.
//
// Pure data, frozen. Resolution lives in resolve.mjs so this table stays the
// single source for both the resolver and the documentation.

/** Port name -> { implementations: readonly string[], fallback: string }. */
export const PORTS = Object.freeze({
	scope: Object.freeze({
		implementations: Object.freeze(["bare", "single", "batch"]),
		fallback: "batch",
	}),
	relay: Object.freeze({
		implementations: Object.freeze(["none", "ledger", "handoff"]),
		fallback: "handoff",
	}),
	clock: Object.freeze({ implementations: Object.freeze(["on", "off"]), fallback: "on" }),
	stages: Object.freeze({ implementations: Object.freeze(["on", "off"]), fallback: "on" }),
	herd: Object.freeze({ implementations: Object.freeze(["on", "off"]), fallback: "on" }),
	pin: Object.freeze({ implementations: Object.freeze(["on", "off"]), fallback: "on" }),
	amend: Object.freeze({ implementations: Object.freeze(["on", "off"]), fallback: "on" }),
	folding: Object.freeze({ implementations: Object.freeze(["on", "off"]), fallback: "on" }),
	modelSwitch: Object.freeze({ implementations: Object.freeze(["on", "off"]), fallback: "on" }),
	status: Object.freeze({ implementations: Object.freeze(["on", "off"]), fallback: "on" }),
	observer: Object.freeze({ implementations: Object.freeze(["on", "off"]), fallback: "on" }),
});

/** The environment variable that selects a port's implementation. */
export function switchName(port) {
	return `HERD_${port.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

/**
 * Ports whose switch takes an implementation name. Every other port keeps the
 * boolean form `HERD_DISABLE_<PORT>=1`, which means "choose off".
 */
export const NAMED_SWITCHES = Object.freeze(new Set(["scope", "relay"]));

/** Every port name, in table order. */
export const PORT_NAMES = Object.freeze(Object.keys(PORTS));
