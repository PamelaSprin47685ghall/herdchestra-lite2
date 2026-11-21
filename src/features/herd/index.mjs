// herd port: the session's decision-framing mode.
//
// Two implementations, same three methods. `on` lets the user toggle the mode;
// `off` reports "off" forever and refuses a toggle. Neither knows which one it
// is: the switch lives in the wiring.

/**
 * `store` is the caller's persistent mode holder (`{ herdMode: boolean }`).
 * Writing through it keeps a session restore on the same answer this port
 * reports; a closure-owned flag would flip back to "off" on reload.
 */
export function createHerdOn(store = { herdMode: false }) {
	return {
		name: "on",
		mode() {
			return store.herdMode === true ? "on" : "off";
		},
		toggle(text) {
			store.herdMode = store.herdMode !== true;
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

export const HERD_IMPLEMENTATIONS = Object.freeze({
	on: createHerdOn,
	off: createHerdOff,
});
