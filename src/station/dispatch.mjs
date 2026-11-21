// Dispatch preflight: map every tool call of one assistant message to its
// position and name. Pure; the station owns the state.

import { toolCalls } from "../transcript/index.mjs";

/**
 * Map every tool call id to its position in the message.
 */
export function planDispatch(message) {
	const positions = new Map();
	for (const call of toolCalls(message)) {
		positions.set(call.id, { name: call.name });
	}
	return { positions };
}
