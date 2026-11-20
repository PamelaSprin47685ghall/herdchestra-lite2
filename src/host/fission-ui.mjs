import { createEventMux } from "./event-mux.mjs";

const bridges = new WeakMap();

/**
 * The retirement banner.
 *
 * Retiring an owner is a deliberate handover, not a failed turn. The host
 * still synthesizes two artifacts for it: an `aborted` assistant message whose
 * `errorMessage` carries the abort reason, and an error tool result for every
 * call the aborted batch never ran. Neither says anything the user can act on,
 * so the live stream drops both.
 *
 * Matching is on the exact reason string this extension passes to
 * `agent.abort()`; a user interrupt or a provider failure carries a different
 * text and stays visible.
 */
const OWNER_RETIRED_REASON = "Fission owner retired";

function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.join("\n");
}

/** True for the host's own record of a deliberate owner retirement. */
export function isRetiredOwnerArtifact(event) {
	const message = event?.message;
	if (!message || typeof message !== "object") return false;
	if (message.role === "assistant") {
		return message.stopReason === "aborted" && message.errorMessage === OWNER_RETIRED_REASON;
	}
	if (message.role === "toolResult" && message.isError === true) {
		return messageText(message).includes(OWNER_RETIRED_REASON);
	}
	return false;
}

/**
 * Install before the session's UI subscribes. Existing subscribers are private
 * to the host and cannot be moved into the multiplexed stream afterwards.
 */
export function installFissionUI(session, { hasBatch = () => false, broadcastPresented } = {}) {
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
	let working = false;
	let interrupted = false;
	const publishedBroadcasts = new Set();
	function publish(event, acknowledged) {
		const pending = acknowledged ? [] : null;
		for (const entry of [...listeners]) {
			if (!entry.active) continue;
			const result = entry.listener(event);
			if (pending && result?.then) pending.push(result);
		}
		if (pending?.length) void Promise.allSettled(pending).then(acknowledged);
		else acknowledged?.();
	}
	const mux = createEventMux(publish);

	function publishBroadcast(event) {
		const message = event.message;
		const data = message?.details?.fissionBroadcast;
		if (message?.customType !== "fission.broadcast" || typeof data?.text !== "string") return false;
		if (event.type !== "message_start" || publishedBroadcasts.has(data.broadcastId)) return true;
		publishedBroadcasts.add(data.broadcastId);
		// Let the native composer reconcile its optimistic echo against the
		// original submission. User messages don't own the assistant's display
		// lease: another flow can still be streaming when this steer is sent.
		const images = Array.isArray(message.content) ? message.content.filter((part) => part.type === "image") : [];
		const input = { ...message, role: "user", attribution: "user", content: [{ type: "text", text: data.text }, ...images] };
		publish(
			{ ...event, message: input },
			broadcastPresented && (() => broadcastPresented(data.broadcastId)),
		);
		publish({ type: "message_end", message: input });
		return true;
	}

	function accept(id, event) {
		if (id !== owner && interrupted) return;
		if (publishBroadcast(event)) return;
		if (event.type === "agent_start") {
			if (working && (id !== owner || hasBatch())) return;
			working = true;
		}
		if (event.type === "agent_end") {
			if (hasBatch() || id !== owner) return;
			working = false;
		}
		// Maintenance and queue state belong to the individual AgentSession.
		// Forwarding another session's controls advertises an abort target the
		// owner doesn't have. Its work is represented by the aggregate loader.
		if (id !== owner && (event.type === "agent_pause" || event.type === "queue_update" ||
			event.type.startsWith("auto_retry_") || event.type.startsWith("auto_compaction_"))) return;
		mux.accept(id, event);
	}

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
		if (!active || isRetiredOwnerArtifact(event)) return;
		accept(owner, event);
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
		get presentsBroadcasts() { return listeners.size > 0; },
		beginWork() {
			if (!active) return;
			interrupted = false;
			if (working) return;
			working = true;
			mux.accept(owner, { type: "agent_start" });
		},
		queueChanged() {
			if (active) publish({ type: "queue_update", ...session.getQueuedMessages?.() });
		},
		endWork({ messages, interrupted: wasInterrupted }) {
			if (!active || !working) return;
			working = false;
			interrupted = wasInterrupted === true;
			if (interrupted) for (const flow of flows.keys()) mux.drop(flow);
			mux.accept(owner, { type: "agent_end", messages });
		},
		accept(flow, event) {
			if (!active) throw new Error("Fission UI bridge is disposed");
			accept(flow, event);
		},
		cancel(flow, endEvent) {
			if (!active) throw new Error("Fission UI bridge is disposed");
			mux.cancel(flow, endEvent);
		},
		attach(flow, source) {
			if (!active) throw new Error("Fission UI bridge is disposed");
			if (flows.has(flow)) throw new Error("Flow is already attached");
			if (typeof source?.subscribe !== "function") throw new TypeError("Flow subscribe is unavailable");
			const unsubscribe = source.subscribe((event) => accept(flow, event));
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
