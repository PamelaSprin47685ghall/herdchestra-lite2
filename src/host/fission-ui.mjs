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

	function restoreSubscribe() {
		if (session.subscribe !== subscribe) return;
		try {
			if (ownDescriptor) Object.defineProperty(session, "subscribe", ownDescriptor);
			else delete session.subscribe;
		} catch {
			// The host keeps the method it ended with. Teardown must still
			// finish: a failed restore must not hide a dead cached bridge.
		}
	}

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
	// Define the method instead of assigning it: an accessor's setter is host
	// state this bridge must not touch, and a refused patch has to leave the
	// session exactly as it was found.
	try {
		Object.defineProperty(session, "subscribe", {
			value: subscribe,
			configurable: true,
			enumerable: ownDescriptor?.enumerable ?? false,
			writable: true,
		});
		if (session.subscribe !== subscribe) throw new Error("Session subscribe cannot be patched");
	} catch (error) {
		try {
			unsubscribeOwner();
		} catch {
			// The patch already failed; the original error is the answer.
		}
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
				// Detach is a flow's terminal edge. Release its open window
				// before the source goes quiet: otherwise one dead flow holds
				// the session's single lease and every other flow freezes.
				mux.drop(flow);
				unsubscribe();
			};
		},
		get listenerCount() { return listeners.size; },
		dispose() {
			if (!active) return;
			active = false;
			// Drop the cache first. A host unsubscribe that throws must never
			// leave a dead bridge to be returned by a later install.
			bridges.delete(session);
			try {
				unsubscribeOwner();
			} catch {
				// The owner callback is already gated by `active`.
			}
			// Stop multiplexed delivery before dropping flows: a drop may close
			// a window, and teardown must not publish into a dying stream.
			listeners.clear();
			for (const [flow, unsubscribe] of [...flows]) {
				mux.drop(flow);
				try {
					unsubscribe();
				} catch {
					// Detach is best effort.
				}
			}
			flows.clear();
			restoreSubscribe();
		},
	};
	bridges.set(session, bridge);
	return bridge;
}
