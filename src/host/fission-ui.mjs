import { createEventMux } from "./event-mux.mjs";

const bridges = new WeakMap();

/**
 * Install before the session's UI subscribes. Existing subscribers are private
 * to the host and cannot be moved into the multiplexed stream afterwards.
 */
export function installFissionUI(session) {
	if (!session || typeof session.subscribe !== "function") {
		throw new TypeError("Session subscribe is unavailable");
	}
	const existing = bridges.get(session);
	if (existing) return existing;

	const original = session.subscribe;
	const ownDescriptor = Object.getOwnPropertyDescriptor(session, "subscribe");
	const listeners = new Set();
	const flows = new Map();
	const owner = Symbol("owner");
	let active = true;
	const mux = createEventMux((event) => {
		for (const entry of [...listeners]) {
			if (entry.active) entry.listener(event);
		}
	});

	function subscribe(listener) {
		if (typeof listener !== "function") throw new TypeError("Listener must be a function");
		const entry = { listener, active: true };
		const unsubscribe = original.call(this, (event) => {
			if (!active && entry.active) listener(event);
		});
		listeners.add(entry);
		return () => {
			if (!entry.active) return;
			entry.active = false;
			listeners.delete(entry);
			unsubscribe();
		};
	}

	// Register once so one host event enters the mux once, not once per listener.
	const unsubscribeOwner = original.call(session, (event) => {
		if (active) mux.accept(owner, event);
	});
	try {
		session.subscribe = subscribe;
		if (session.subscribe !== subscribe) throw new Error("Session subscribe cannot be patched");
	} catch (error) {
		unsubscribeOwner();
		throw error;
	}

	const bridge = {
		accept(flow, event) {
			if (!active) throw new Error("Fission UI bridge is disposed");
			mux.accept(flow, event);
		},
		cancel(flow, endEvent) {
			if (!active) throw new Error("Fission UI bridge is disposed");
			mux.cancel(flow, endEvent);
		},
		attach(flow, source) {
			if (!active) throw new Error("Fission UI bridge is disposed");
			if (flows.has(flow)) throw new Error("Flow is already attached");
			if (typeof source?.subscribe !== "function") throw new TypeError("Flow subscribe is unavailable");
			const unsubscribe = source.subscribe((event) => mux.accept(flow, event));
			flows.set(flow, unsubscribe);
			return () => {
				if (flows.get(flow) !== unsubscribe) return;
				flows.delete(flow);
				unsubscribe();
			};
		},
		get listenerCount() { return listeners.size; },
		dispose() {
			if (!active) return;
			active = false;
			unsubscribeOwner();
			for (const unsubscribe of flows.values()) unsubscribe();
			flows.clear();
			if (session.subscribe === subscribe) {
				if (ownDescriptor) Object.defineProperty(session, "subscribe", ownDescriptor);
				else delete session.subscribe;
			}
			listeners.clear();
			bridges.delete(session);
		},
	};
	bridges.set(session, bridge);
	return bridge;
}
