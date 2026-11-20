// One instance belongs to one session, including all nested batches.
export function createEventMux(emit) {
	let owner = null;
	let draining = false;
	const queue = [];
	const messages = new Map();
	const broadcasts = new Set();

	function broadcastId(event) {
		return event.message?.details?.fissionBroadcast?.broadcastId;
	}

	function publish(event) {
		emit(event);
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
				owner = item.flowId;
				publish(item.start);
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
			const id = broadcastId(event);
			const duplicate = id != null && broadcasts.has(id);
			if (id != null) broadcasts.add(id);
			message = { flowId, start: event, duplicate, queued: false };
			messages.set(flowId, message);
			if (duplicate) return;
			if (owner === null && queue.length === 0 && !draining) {
				owner = flowId;
				publish(event);
			} else {
				message.queued = true;
				queue.push(message);
				drain();
			}
			return;
		}
		if (type === "message_update" || type === "message_end") {
			if (!message) throw new Error("Flow has no open message");
			if (type === "message_end") messages.delete(flowId);
			if (message.duplicate) return;
			if (message.queued) {
				if (type === "message_update") message.update = event;
				else message.end = event;
			} else {
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
				if (item.kind === "event" && item.flowId === flowId &&
					item.event.type === "tool_execution_update" &&
					item.event.toolCallId === event.toolCallId) queue.splice(i, 1);
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
		if (messages.has(flowId)) {
			if (endEvent?.type !== "message_end") throw new Error("Cancellation requires a message_end event");
			accept(flowId, endEvent);
		}
	}

	return { accept, cancel, drain };
}
