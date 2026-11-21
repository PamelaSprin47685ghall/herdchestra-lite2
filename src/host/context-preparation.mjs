// Commit request state before the host clones context for extension handlers.
// The running loop and Agent state must keep separate message arrays.

import { rememberSession, sessionMatchesContext } from "./capture.mjs";
import { messagesOf } from "./adapter.mjs";
import { commitSkillReceipt, sameAssistantFrame } from "./hack-context.mjs";
import { record } from "./diagnostics.mjs";
import { isDeepStrictEqual } from "node:util";

const PREPARATION = Symbol.for("herdchestra-lite2.context-preparation.v1");
const INPUT_ROLES = new Set(["user", "developer", "custom", "fileMention", "hookMessage"]);

function failure(code, message, cause) {
	const error = new Error(message, cause === undefined ? undefined : { cause });
	error.code = code;
	return error;
}

function checkSignal(signal) {
	signal?.throwIfAborted?.();
	if (signal?.aborted) {
		throw failure("ABORT_ERR", "Context preparation was cancelled.");
	}
}

function stateStamp(station) {
	return { state: station.state, epoch: station.state?.epoch };
}

function checkState(station, stamp) {
	if (station.state !== stamp.state || station.state?.epoch !== stamp.epoch) {
		throw failure("CONTEXT_PREPARATION_STALE", "The station state changed while the request was being prepared.");
	}
}

function toolCallIds(message) {
	const ids = new Set();
	const content = message?.content;
	if (!Array.isArray(content)) return ids;
	for (const item of content) {
		if (item?.type === "toolCall" && typeof item.id === "string") ids.add(item.id);
	}
	return ids;
}

function committedToolCallIds(prefix) {
	for (let index = prefix.length - 1; index >= 0; index -= 1) {
		const message = prefix[index];
		if (message?.role === "assistant") return toolCallIds(message);
	}
	return new Set();
}

/**
 * Separate dead output from queued input.
 *
 * A frame is one assistant message and the tool results it declares. The host
 * appends frames and results separately, so a frame can appear anywhere in the
 * uncommitted tail, including after a queued steer. Those frames never became
 * model input and are isolated.
 *
 * A tool result whose assistant frame is still in the committed prefix is a
 * half-committed frame. Its request cannot take a receipt between the call and
 * the result, so it is reported through `frameInFlight`; the caller defers
 * preparation instead of aborting. A tool result that belongs to neither the
 * pending frame nor the committed one is corruption and still throws.
 */
function partitionPending(pending, prefix) {
	const recovered = [];
	const kept = [];
	let frame = null;
	let sawInput = false;
	let frameInFlight = false;
	let committedIds = null;
	for (const message of pending) {
		const role = message?.role;
		if (role === "assistant") {
			frame = toolCallIds(message);
			recovered.push(message);
			continue;
		}
		if (role === "toolResult") {
			const id = message?.toolCallId;
			if (frame !== null && typeof id === "string" && frame.has(id)) {
				recovered.push(message);
				continue;
			}
			if (frame === null && !sawInput) {
				committedIds ??= committedToolCallIds(prefix);
				if (typeof id === "string" && committedIds.has(id)) {
					frameInFlight = true;
					recovered.push(message);
					continue;
				}
			}
			throw failure(
				"CONTEXT_PREPARATION_HISTORY_MISMATCH",
				"An uncommitted tool result does not belong to the assistant frame before it.",
			);
		}
		if (INPUT_ROLES.has(role)) {
			sawInput = true;
			frame = null;
			kept.push(message);
			continue;
		}
		throw failure(
			"CONTEXT_PREPARATION_HISTORY_MISMATCH",
			"The live loop contains uncommitted output that cannot be aligned safely with the committed history.",
		);
	}
	return { recovered, pending: kept, frameInFlight };
}

/** Separate committed history from input whose host events have not run yet. */
export function splitRequestHistory(messages, committed) {
	if (!Array.isArray(messages) || !Array.isArray(committed)) {
		throw failure("CONTEXT_PREPARATION_INVALID_CONTEXT", "Both loop and Agent histories are required.");
	}
	let end = -1;
	if (committed.length > 0) {
		const tail = committed.at(-1);
		end = messages.lastIndexOf(tail);
		if (end >= 0 && messages.indexOf(tail) !== end) {
			throw failure("CONTEXT_PREPARATION_HISTORY_MISMATCH", "The last committed message appears at more than one loop position.");
		}
		if (end < 0) {
			let matches = 0;
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				if (sameAssistantFrame(messages[index], tail) || isDeepStrictEqual(messages[index], tail)) {
					end = index;
					matches += 1;
				}
			}
			if (matches > 1) {
				throw failure("CONTEXT_PREPARATION_HISTORY_MISMATCH", "The last committed message has more than one possible loop position.");
			}
		}
		if (end < 0) {
			throw failure("CONTEXT_PREPARATION_HISTORY_MISMATCH", "The live loop does not contain the last committed message.");
		}
	}
	const prefix = messages.slice(0, end + 1);
	const partitioned = partitionPending(messages.slice(end + 1), prefix);
	return {
		prefix,
		pending: partitioned.pending,
		recovered: partitioned.recovered,
		frameInFlight: partitioned.frameInFlight,
	};
}

function commitPrepared(registration, binding, signal, context, request, receipt) {
	checkSignal(signal);
	if (!registration.active) return;
	const { original, items, split, stamp } = request;
	if (registration.binding !== binding || context.messages !== original || original.length !== items.length ||
		original.some((message, index) => message !== items[index])) {
		throw failure("CONTEXT_PREPARATION_STALE", "The request changed while its state was being prepared.");
	}
	checkState(binding.station, stamp);
	if (receipt === null) return;
	if (receipt?.herdSkill !== true) {
		throw failure("CONTEXT_PREPARATION_INVALID_RECEIPT", "The station did not supply a skill receipt.");
	}
	const { session, station } = binding;
	const messages = split.prefix.at(-1)?.herdSkill === true ? split.prefix : [...split.prefix, receipt];
	const committed = commitSkillReceipt(station.manager, messages, session);
	// Pending inputs still belong to the host. It emits and persists them after
	// request preparation; placing the receipt first preserves that order.
	context.messages = [...committed, ...split.pending];
}

function prepareState(registration, binding, signal, context, persistedStamp) {
	checkSignal(signal);
	if (!registration.active) return;
	if (registration.binding !== binding) {
		throw failure("CONTEXT_PREPARATION_STALE", "The agent binding changed while history was being persisted.");
	}
	if (persistedStamp) checkState(binding.station, persistedStamp);
	if (!Array.isArray(context?.messages)) {
		throw failure("CONTEXT_PREPARATION_INVALID_CONTEXT", "The model call has no live message array.");
	}
	const { station, ctx } = binding;
	const original = context.messages;
	const items = original.slice();
	const split = splitRequestHistory(original, messagesOf(binding.session));
	if (split.frameInFlight) {
		record("context", "Deferred request preparation for an in-flight tool frame.", {
			count: split.recovered.length,
			roles: [...new Set(split.recovered.map((message) => message?.role))],
			toolCallIds: split.recovered
				.filter((message) => message?.role === "toolResult")
				.map((message) => message.toolCallId),
		});
		return;
	}
	if (split.recovered.length > 0) {
		record("context", "Isolated uncommitted messages from the live loop.", {
			count: split.recovered.length,
			roles: [...new Set(split.recovered.map((message) => message?.role))],
			toolCallIds: split.recovered
				.filter((message) => message?.role === "toolResult")
				.map((message) => message.toolCallId),
		});
	}
	const receipt = station.prepareRequest(ctx, split.prefix.at(-1));
	// Boundary observation can advance the epoch synchronously. Only later
	// changes, while a restore ticket is pending, invalidate this request.
	const request = { original, items, split, stamp: stateStamp(station) };
	if (receipt && typeof receipt.then === "function") {
		return Promise.resolve(receipt).then((settled) =>
			commitPrepared(registration, binding, signal, context, request, settled),
		);
	}
	return commitPrepared(registration, binding, signal, context, request, receipt);
}

function prepare(registration, signal, context) {
	checkSignal(signal);
	const binding = registration.binding;
	const settle = binding.session.settleInFlightMessagePersistence;
	if (typeof settle === "function") {
		const stamp = stateStamp(binding.station);
		return Promise.resolve(settle.call(binding.session)).then(() =>
			prepareState(registration, binding, signal, context, stamp),
		);
	}
	return prepareState(registration, binding, signal, context);
}

/** Install one removable hook per agent. Later calls update its binding. */
export function installContextPreparation(session, { station, ctx } = {}) {
	const agent = session?.agent;
	if (typeof agent?.addBeforeModelCallHook !== "function") {
		throw failure(
			"CONTEXT_PREPARATION_UNAVAILABLE",
			"The host must support agent.addBeforeModelCallHook to retain request state.",
		);
	}
	if (typeof station?.prepareRequest !== "function") {
		throw failure("CONTEXT_PREPARATION_INVALID_BINDING", "A station with prepareRequest() is required.");
	}
	if (!sessionMatchesContext(session, ctx)) {
		throw failure("CONTEXT_PREPARATION_INVALID_BINDING", "The context and session have different agent identities.");
	}
	rememberSession(session);
	const binding = { session, station, ctx };
	const installed = agent[PREPARATION];
	if (installed?.active) {
		installed.binding = binding;
		return installed.remove;
	}

	const registration = { active: true, binding, remove: null };
	let detach;
	registration.remove = () => {
		if (!registration.active) return;
		registration.active = false;
		try {
			if (typeof detach === "function") detach();
		} finally {
			if (agent[PREPARATION] === registration) delete agent[PREPARATION];
		}
	};
	try {
		Object.defineProperty(agent, PREPARATION, { value: registration, configurable: true });
		detach = agent.addBeforeModelCallHook((signal, context) => {
			if (registration.active) return prepare(registration, signal, context);
		});
		if (typeof detach !== "function") {
			throw failure("CONTEXT_PREPARATION_UNAVAILABLE", "The host context hook cannot be removed.");
		}
	} catch (error) {
		registration.remove();
		if (error?.code) throw error;
		throw failure("CONTEXT_PREPARATION_UNAVAILABLE", "The host context hook could not be installed.", error);
	}
	return registration.remove;
}
