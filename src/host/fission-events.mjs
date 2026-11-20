import { createEventMux } from "./event-mux.mjs";

const bridges = new WeakMap();

/**
 * Capture future session subscribers and feed them one multiplexed event stream.
 * Install before the UI subscribes; the host does not expose earlier listeners.
 * The bridge forwards only presentation events. Session persistence and extension
 * hooks remain the responsibility of the host's private event handler.
 */
export function installFissionEvents(session) {
	const existing = bridges.get(session);
	if (existing) return existing;
	if (typeof session?.subscribe !== "function") throw new TypeError("Session subscribe is unavailable");
	const original = session.subscribe;
	const listeners = new Set();
	const mux = createEventMux((event) => {
		for (const listener of [...listeners]) listener(event);
	});
	function subscribe(listener) {
		listeners.add(listener);
		const unsubscribe = original.call(this, listener);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			listeners.delete(listener);
			unsubscribe();
		};
	}
	session.subscribe = subscribe;
	const bridge = {
		accept: (flow, event) => mux.accept(flow, event),
		cancel: (flow, event) => mux.cancel(flow, event),
		get listenerCount() { return listeners.size; },
		dispose() {
			if (session.subscribe === subscribe) session.subscribe = original;
			listeners.clear();
			bridges.delete(session);
		},
	};
	bridges.set(session, bridge);
	return bridge;
}
