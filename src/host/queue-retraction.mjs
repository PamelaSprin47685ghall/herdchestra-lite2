// Queue retraction: take back only the broadcast copies this flow queued.
//
// The host keeps a queued copy in three places: the pending steering and
// follow-up queues, the batch it dequeued for the next model call, and the
// live-steered messages a provider already took into its in-flight response.
// clearSteeringQueue() touches only the first, and abort() restores the other
// two, so a whole-queue clear both destroys the user's own input and lets our
// copy resurface as a ghost turn.
//
// Nothing here throws on a host refusal. A missing or throwing read proves
// nothing, so it counts as still held: routing such a copy onward would show
// the text a second time if the host ever runs the stale copy. The caller
// reports the text instead, through the port it supplies.
//
// This module owns no state. It reads one flow's agent and its batch warnings
// through the ports argument, so every branch is testable with a fake agent.

const QUEUES = ["steering", "followUp"];

function queuePeek(agent, queue) {
	return queue === "steering" ? agent?.peekSteeringQueue : agent?.peekFollowUpQueue;
}

function queueAppend(agent, queue, message) {
	if (queue === "steering") {
		if (typeof agent?.steer !== "function") throw new Error("agent.steer() is unavailable");
		agent.steer(message);
		return;
	}
	if (typeof agent?.followUp !== "function") throw new Error("agent.followUp() is unavailable");
	agent.followUp(message);
}

/** Plain text of a queued message, or null when it carries none. */
export function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts = content
		.map((part) =>
			typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")
		.filter((part) => part.length > 0);
	return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * True when this agent can still reach the copy.
 *
 * A readable queue that lists it is proof. A readable queue that does not list
 * it is proof of absence only after a successful withdraw cleared the
 * undelivered set; without that call, an unreadable undelivered set could still
 * hold it.
 */
export function flowStillHoldsCopy(agent, entry, isCopy, probe) {
	for (const queue of QUEUES) {
		const peek = queuePeek(agent, queue);
		if (typeof peek !== "function") continue;
		let pending;
		try {
			pending = peek.call(agent);
		} catch {
			return true;
		}
		if (Array.isArray(pending) && pending.some(isCopy)) return true;
	}
	const peekUndelivered = agent?.peekUndeliveredQueuedMessages;
	if (typeof peekUndelivered === "function") {
		let pending;
		try {
			pending = peekUndelivered.call(agent);
		} catch {
			return true;
		}
		if (Array.isArray(pending) && pending.some(isCopy)) return true;
	}
	if (probe.withdrawn.some(isCopy)) return false;
	return !probe.withdrew && typeof peekUndelivered !== "function";
}

/**
 * Put the host's own withdrawn input back at the head of its queue.
 *
 * The host withdraws every undelivered message of a run, not only ours, so
 * preserving our text must never cost the user's. Nothing here throws: a
 * message the host handed back and then refused to take again is returned as
 * lost, so the caller can report it with its text instead of letting the
 * exception be its only trace.
 */
export function requeueKept(agent, queue, messages, isCopy) {
	if (!Array.isArray(messages)) return { lost: [], error: null };
	const kept = messages.filter((message) => !isCopy(message));
	if (kept.length === 0) return { lost: [], error: null };
	const peek = queuePeek(agent, queue);
	const readQueue = () => {
		if (typeof peek !== "function") return null;
		try {
			const pending = peek.call(agent);
			return Array.isArray(pending) ? pending : null;
		} catch {
			return null;
		}
	};
	let pending = readQueue();
	let error = null;
	if (pending !== null && typeof agent?.replaceQueue === "function") {
		try {
			agent.replaceQueue(queue, [...kept, ...pending]);
			return { lost: [], error };
		} catch (caught) {
			error = caught;
			// A refused rewrite may still have landed; read again before adding
			// a second copy of the user's text.
			pending = readQueue();
			if (pending === null) return { lost: kept, error };
		}
	}
	const missing = pending === null ? kept : kept.filter((message) => !pending.includes(message));
	const lost = [];
	for (const message of missing) {
		try {
			queueAppend(agent, queue, message);
		} catch (caught) {
			error ??= caught;
			lost.push(message);
		}
	}
	if (lost.length === 0) return { lost, error };
	// Trust an append only when the queue confirms it. An unreadable queue
	// proves nothing, so the message stays reported.
	const after = readQueue();
	if (after === null) return { lost, error };
	return { lost: lost.filter((message) => !after.includes(message)), error };
}

/**
 * Withdraw, restore, strip, then probe.
 *
 * `ports.warn(code, error)` reports a refused host call; `ports.lost(queue,
 * message, error)` reports the user's own input that could not be put back.
 * Every host call stands alone: one failure must not skip the rest of the
 * retraction, and the host's own input must never vanish with it.
 *
 * Returns the entries whose copy could not be proven gone.
 */
export function retractQueuedCopies(flow, entries, ports = {}) {
	if (entries.length === 0) return new Set();
	const agent = flow.agent;
	const ours = new Set(entries.map((entry) => entry.message));
	const ids = new Set(entries.map((entry) => entry.broadcastId));
	const isCopy = (message) =>
		ours.has(message) ||
		ids.has(message?.details?.fissionBroadcast?.broadcastId);
	const probe = {
		withdrew: false,
		withdrawn: [],
		withdrawnByQueue: { steering: [], followUp: [] },
	};
	const warn = (code, error) => ports.warn?.(code, error);
	const lost = (queue, message, error) => ports.lost?.(queue, message, error);
	// The withdraw is the only call that can prove a provider no longer holds
	// a copy. Its failure is reported, and the pending queues are still
	// stripped below.
	if (typeof agent?.withdrawUndeliveredQueuedMessages === "function") {
		try {
			const withdrawn = agent.withdrawUndeliveredQueuedMessages() ?? {};
			probe.withdrew = true;
			probe.withdrawnByQueue.steering = Array.isArray(withdrawn.steering) ? withdrawn.steering : [];
			probe.withdrawnByQueue.followUp = Array.isArray(withdrawn.followUp) ? withdrawn.followUp : [];
			probe.withdrawn = [
				...probe.withdrawnByQueue.steering,
				...probe.withdrawnByQueue.followUp,
			];
		} catch (error) {
			warn("FLOW_QUEUE_RETRACT_FAILED", error);
		}
	}
	// Put the host's own input back one queue at a time: a refusal in one
	// queue never strands the other, and whatever cannot be put back is
	// reported with its text rather than silently lost.
	if (probe.withdrew) {
		for (const queue of QUEUES) {
			const withdrawn = probe.withdrawnByQueue[queue];
			try {
				const restored = requeueKept(agent, queue, withdrawn, isCopy);
				for (const message of restored.lost) {
					lost(queue, message, restored.error);
				}
			} catch (error) {
				// requeueKept is total by design; this guards a host whose
				// accessors throw, so no message goes unreported.
				for (const message of withdrawn.filter((entry) => !isCopy(entry))) {
					lost(queue, message, error);
				}
			}
		}
	}
	// Strip our copies from both pending queues. Each queue stands alone: a
	// throwing read or rewrite of one is reported and the other still runs,
	// because a skipped strip leaves a ghost turn behind.
	for (const queue of QUEUES) {
		const peek = queuePeek(agent, queue);
		if (typeof peek !== "function" || typeof agent?.replaceQueue !== "function") continue;
		try {
			const pending = peek.call(agent);
			if (!Array.isArray(pending)) continue;
			const kept = pending.filter((message) => !isCopy(message));
			if (kept.length !== pending.length) agent.replaceQueue(queue, kept);
		} catch (error) {
			warn("FLOW_QUEUE_RETRACT_FAILED", error);
		}
	}
	const stuck = new Set();
	for (const entry of entries) {
		if (flowStillHoldsCopy(agent, entry, isCopy, probe)) stuck.add(entry);
	}
	return stuck;
}
