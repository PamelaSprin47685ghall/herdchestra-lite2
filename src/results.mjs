/**
 * Shared result and event-shape helpers. Leaf module: no imports.
 *
 * textResult/errorResult build the tool-result objects the host expects.
 * continueFeedback builds the session_stop continuation the host accepts.
 * isHandoffCompaction recognizes a host compaction event that marks a handoff.
 */

export function textResult(text, details) {
	return details === undefined
		? { content: [{ type: "text", text }] }
		: { content: [{ type: "text", text }], details };
}

export function errorResult(code, message, details) {
	return {
		isError: true,
		content: [{ type: "text", text: `${code}: ${message}` }],
		details: { code, ...(details ?? {}) },
	};
}

/**
 * A session_stop continuation. The stop hook turns a handoff outcome into the
 * one continuation the host accepts; only `undefined` allows a natural stop.
 */
export function continueFeedback(text) {
	if (!text) return undefined;
	return { continue: true, additionalContext: text };
}

/** True when a host compaction event marks a handoff transition. */
export function isHandoffCompaction(event) {
	if (!event || typeof event !== "object") return false;
	if (event.handoff === true || event.isHandoff === true) return true;
	const action =
		event.action ??
		event.compaction?.action ??
		event.reason ??
		event.source ??
		event.kind;
	return action === "handoff";
}
