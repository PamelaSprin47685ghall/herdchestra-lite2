// One instance belongs to one session, including all nested batches.
export function createEventMux(emit) {
	let owner = null;
	let draining = false;
	const queue = [];
	const messages = new Map();
	// An id is remembered only once a copy reaches the screen. Claiming it on
	// arrival would let a copy that never displays (its flow is dropped first)
	// consume the id and hide every surviving copy; the design remembers the
	// ids that were rendered (8.1).
	const broadcasts = new Set();
	// A cancelled or dropped message is closed for good. The source that
	// produced it may still deliver the same copy's terminal events; they
	// belong to a closed message and are dropped instead of throwing into the
	// emitter.
	const cancelled = new Set();

	function broadcastId(event) {
		return event.message?.details?.fissionBroadcast?.broadcastId;
	}

	function publish(event) {
		emit(event);
	}

	// Decide display when the copy is about to be shown, never at arrival: a
	// queued copy is re-checked when it is promoted, and a copy that loses the
	// race is skipped without taking the lease, so drain moves on at once.
	function show(record) {
		if (record.skipped) return false;
		const id = broadcastId(record.start);
		if (id != null) {
			if (broadcasts.has(id)) {
				record.skipped = true;
				return false;
			}
			broadcasts.add(id);
		}
		publish(record.start);
		return true;
	}

	// Close a window whose source will never end it, using the last snapshot
	// that source sent and the aborted label the host puts on a message it had
	// to cut short. Nothing else is invented.
	function close(record) {
		const snapshot = record.update?.message ?? record.start.message;
		if (snapshot && typeof snapshot === "object") {
			publish({ type: "message_end", message: { ...snapshot, stopReason: "aborted" } });
		}
	}

	function drain() {
		if (draining || owner !== null) return;
		draining = true;
		try {
			while (owner === null && queue.length) {
				const item = queue.shift();
				if (item.kind === "event") {
					publish(item.event);
					continue;
				}
				item.queued = false;
				if (!show(item)) continue;
				owner = item.flowId;
				if (item.update) publish(item.update);
				if (item.end) {
					publish(item.end);
					owner = null;
				} else {
					break;
				}
			}
		} finally {
			draining = false;
		}
	}

	function accept(flowId, event) {
		const type = event.type;
		let message = messages.get(flowId);
		if (type === "message_start") {
			if (message) throw new Error("Flow already has an open message");
			cancelled.delete(flowId);
			message = { flowId, start: event, skipped: false, queued: false };
			messages.set(flowId, message);
			if (owner === null && queue.length === 0 && !draining) {
				if (!show(message)) return;
				owner = flowId;
			} else {
				message.queued = true;
				queue.push(message);
				drain();
			}
			return;
		}
		if (type === "message_update" || type === "message_end") {
			if (!message) {
				if (cancelled.has(flowId)) return;
				throw new Error("Flow has no open message");
			}
			if (type === "message_end") messages.delete(flowId);
			if (message.skipped) return;
			if (message.queued) {
				if (type === "message_update") message.update = event;
				else message.end = event;
			} else {
				if (type === "message_update") message.update = event;
				publish(event);
				if (type === "message_end") {
					owner = null;
					drain();
				}
			}
			return;
		}

		const toolEvent = type === "tool_execution_start" ||
			type === "tool_execution_update" || type === "tool_execution_end";
		if ((owner === null && queue.length === 0 && !draining) ||
			(owner === flowId && !toolEvent)) {
			publish(event);
			return;
		}
		if (type === "tool_execution_end") {
			for (let i = queue.length - 1; i >= 0; i -= 1) {
				const item = queue[i];
				if (item.kind !== "event" || item.flowId !== flowId ||
					item.event.toolCallId !== event.toolCallId) continue;
				if (item.event.type === "tool_execution_start" ||
					item.event.type === "tool_execution_end") break;
				if (item.event.type === "tool_execution_update") queue.splice(i, 1);
			}
		}
		// Updates are cumulative. Replace only an adjacent update for the same
		// tool, so events from different tools retain their relative order.
		const previous = queue.at(-1);
		if (type === "tool_execution_update" && previous?.kind === "event" &&
			previous.flowId === flowId && previous.event.type === type &&
			previous.event.toolCallId === event.toolCallId) {
			previous.event = event;
		} else {
			queue.push({ kind: "event", flowId, event });
		}
		drain();
	}

	// The caller supplies the actual terminal event, including the aborted
	// message snapshot. This keeps the host's event shape and reason intact.
	function cancel(flowId, endEvent) {
		if (!messages.has(flowId)) return;
		if (endEvent?.type !== "message_end") throw new Error("Cancellation requires a message_end event");
		// Mark before closing: accept() removes the record, and the source may
		// still deliver the same copy's real end or a late update afterwards.
		cancelled.add(flowId);
		accept(flowId, endEvent);
	}

	// A detached flow is gone for good. Its unfinished message will never get
	// the terminal event the mux waits for, so keeping it would hold the
	// session's only open window forever and freeze every other flow. A copy
	// that already ended while buffered stays in the FIFO and still displays;
	// anything unsent is discarded, and any broadcast id it would have claimed
	// stays free for a surviving copy.
	function drop(flowId) {
		const message = messages.get(flowId);
		if (!message) return;
		messages.delete(flowId);
		cancelled.add(flowId);
		if (message.queued) {
			const index = queue.indexOf(message);
			if (index !== -1) queue.splice(index, 1);
			return;
		}
		if (owner !== flowId) return;
		owner = null;
		close(message);
		drain();
	}

	return { accept, cancel, drop, drain };
}
