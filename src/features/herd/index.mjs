// herd port: the session's autopilot mode.
//
// Two implementations, same three methods. `on` lets the user toggle the mode;
// `off` reports "off" forever and refuses a toggle. Neither knows which one it
// is: the switch lives in the wiring.

/**
 * `store` is the caller's persistent feature holder
 * (`{ features: { autopilot } }`). Writing through it keeps a session restore
 * on the same answer this port reports; a closure-owned flag would flip back to
 * "off" on reload.
 */
export function createHerdOn(store = { features: { autopilot: "off" } }) {
	return {
		name: "on",
		mode() {
			return store.features?.autopilot === "on" ? "on" : "off";
		},
		toggle(text) {
			if (!store.features || typeof store.features !== "object") {
				store.features = { autopilot: "off" };
			}
			store.features.autopilot = store.features.autopilot === "on" ? "off" : "on";
			return { ok: true, mode: this.mode(), text: typeof text === "string" ? text : "" };
		},
	};
}

export function createHerdOff() {
	return {
		name: "off",
		mode() {
			return "off";
		},
		toggle() {
			return { ok: false, code: "HERD_UNAVAILABLE", port: "herd" };
		},
	};
}
