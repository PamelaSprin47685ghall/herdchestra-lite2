// herd port: the session's decision-framing mode.
//
// Two implementations, same three methods. `on` lets the user toggle the mode;
// `off` reports "off" forever and refuses a toggle. Neither knows which one it
// is: the switch lives in the wiring.

export function createHerdOn() {
	let mode = "off";
	return {
		name: "on",
		mode() {
			return mode;
		},
		toggle(text) {
			mode = mode === "on" ? "off" : "on";
			return { ok: true, mode, text: typeof text === "string" ? text : "" };
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
