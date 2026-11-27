  // herd port: whether a one-shot goal session is active.
  //
  // Two implementations, same three methods. `on` reports and toggles the goal
  // flag; `off` reports "off" forever and refuses a toggle. Neither knows which
  // one it is: the switch lives in the wiring.

  /**
   * `store` is the caller's persistent session holder (`{ relay: { goal } }`).
   * Writing through it keeps a session restore on the same answer this port
   * reports; a closure-owned flag would flip back to "off" on reload.
   */
  export function createHerdOn(store = { relay: { goal: false } }) {
  	return {
  		name: "on",
  		mode() {
  			return store.relay?.goal === true ? "on" : "off";
  		},
  		toggle(text) {
  			if (!store.relay || typeof store.relay !== "object") {
  				store.relay = { goal: false };
  			}
  			store.relay.goal = store.relay.goal !== true;
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
