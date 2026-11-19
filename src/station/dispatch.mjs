// Dispatch preflight: where each tool call sits relative to a scope call in
// one assistant message. Pure; the station owns the state.

import { toolCalls } from "../transcript/index.mjs";

/**
 * Map every tool call id to its position. A call is `afterScope` when a scope
 * call appeared earlier in the same assistant message.
 */
export function planDispatch(message) {
	const positions = new Map();
	let afterScope = false;
	for (const call of toolCalls(message)) {
		positions.set(call.id, { name: call.name, afterScope });
		if (call.name === "scope") afterScope = true;
	}
	return { positions, hasScope: afterScope };
}
