/**
 * Dispatch tracker: the message whose tool calls are in flight and the beat
 * key that owns each call. The host reports a tool call before the message
 * that carries it is persisted, so the station must remember the message it is
 * currently preparing. Pure synchronous state.
 */

import { beatKey, toolCalls } from "../transcript/index.mjs";
import { planDispatch } from "./dispatch.mjs";

const GROUP_LIMIT = 1024;
const GROUP_KEEP = 512;

export function createDispatchTracker() {
	let message = null;
	let positions = new Map();
	let preparing = null;
	const groups = new Map();

	function rememberGroups(target) {
		if (!target || target.role !== "assistant") return;
		const key = beatKey(target);
		for (const call of toolCalls(target)) {
			if (!groups.has(call.id)) groups.set(call.id, key);
		}
		if (groups.size > GROUP_LIMIT) {
			for (const id of groups.keys()) {
				groups.delete(id);
				if (groups.size <= GROUP_KEEP) break;
			}
		}
	}

	return {
		/** The message whose tool calls are being dispatched right now. */
		setPreparing(target) {
			preparing = target;
		},

		/** The beat key that owns a tool call, when it is still known. */
		groupKeyFor(toolCallId) {
			return groups.get(toolCallId);
		},

		rememberGroups,

		/**
		 * Remember the message and name one of its calls. Returns nothing:
		 * the caller asks the branch for its wall clock separately.
		 */
		prepare(target, toolCallId, name) {
			if (message !== target) {
				message = target;
				positions = planDispatch(target).positions;
				rememberGroups(target);
			}
			const position = positions.get(toolCallId);
			if (position) position.name = name;
		},

		/** The in-flight or dispatched message that carries this call. */
		messageForToolCall(toolCallId) {
			if (positions.has(toolCallId)) return message;
			if (toolCalls(preparing).some((call) => call.id === toolCallId)) {
				return preparing;
			}
			return null;
		},
	};
}
