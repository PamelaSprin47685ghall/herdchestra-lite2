/**
 * Transcript collapse: rewrite a finished scope's interior into its begin
 * receipt while preserving pin records. Pure. No I/O.
 */

import {
	PIN_TOOL_NAME,
	findBegin,
	findToolCallIndex,
	joinedText,
	toolCalls,
} from "./messages.mjs";

function pinAssistantMessage(message) {
	const content = Array.isArray(message.content) ? message.content : [];
	return {
		...message,
		content: content.filter(
			(block) => block?.type !== "toolCall" || block.name === PIN_TOOL_NAME,
		),
	};
}

/**
 * Return the pin records inside [start, end) in transcript order.
 *
 * A pin assistant keeps its text and thinking blocks plus its pin calls. Other
 * tool calls in the same message are removed, so their results can vanish
 * together. skipResultIds holds results that already survive in place.
 */
export function collectPinnedMessages(messages, options = {}) {
	const source = Array.isArray(messages) ? messages : [];
	const start = Number.isInteger(options.start) ? Math.max(0, options.start) : 0;
	const end = Number.isInteger(options.end)
		? Math.min(source.length, options.end)
		: source.length;
	const skip = options.skipResultIds instanceof Set ? options.skipResultIds : new Set();
	const pinIds = new Set();
	for (let index = start; index < end; index += 1) {
		const message = source[index];
		if (message?.role !== "assistant") continue;
		for (const call of toolCalls(message)) {
			if (call.name === PIN_TOOL_NAME) pinIds.add(call.id);
		}
	}
	if (pinIds.size === 0) return [];
	const pinned = [];
	for (let index = start; index < end; index += 1) {
		const message = source[index];
		if (message?.role === "assistant") {
			if (!toolCalls(message).some((call) => call.name === PIN_TOOL_NAME)) continue;
			pinned.push(pinAssistantMessage(message));
			continue;
		}
		if (
			message?.role === "toolResult" &&
			pinIds.has(message.toolCallId) &&
			!skip.has(message.toolCallId)
		) {
			pinned.push(message);
		}
	}
	return pinned;
}

function isHandoffBoundary(message) {
	if (!message || message.role !== "custom") return false;
	if (message.customType === "handoff" || message.customType === "herd-relay-handoff") {
		return true;
	}
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((block) =>
							typeof block?.text === "string" ? block.text : "",
						)
						.join("\n")
				: "";
	return text.includes("<handoff-context>");
}

function crossesHandoffBoundary(messages, start, end) {
	for (let index = start; index < end; index += 1) {
		if (isHandoffBoundary(messages[index])) return true;
	}
	return false;
}

export function applyCollapses(messages, collapses, epoch = 0) {
	let result = Array.isArray(messages) ? messages.slice() : [];
	const records = Array.isArray(collapses) ? collapses : [];
	const active = records.filter(
		(collapse) =>
			collapse.collapsed !== false && (collapse.epoch ?? 0) === epoch,
	);

	for (const collapse of active) {
		const begin = findBegin(result, collapse.beginToolCallId);
		if (!begin) continue;

		const endAssistantIndex = findToolCallIndex(result, collapse.endToolCallId);
		if (endAssistantIndex < 0 || endAssistantIndex <= begin.resultIndex) continue;
		if (crossesHandoffBoundary(result, begin.resultIndex + 1, endAssistantIndex)) {
			continue;
		}

		const beginToolIds = new Set(toolCalls(begin.assistant).map((call) => call.id));
		const pinned = collectPinnedMessages(result, {
			start: begin.resultIndex + 1,
			end: endAssistantIndex,
			skipResultIds: beginToolIds,
		});
		const next = [];
		let pinnedFlushed = pinned.length === 0;
		const flushPinned = () => {
			if (pinnedFlushed) return;
			pinnedFlushed = true;
			for (const message of pinned) next.push(message);
		};
		for (let index = 0; index < result.length; index += 1) {
			if (index === begin.resultIndex) {
				next.push({
					...begin.result,
					// Keep the omp tool-result shape: one text block.
					content: [{ type: "text", text: finishedReport(collapse.report) }],
					isError: false,
				});
				continue;
			}
			if (index > begin.resultIndex && index < endAssistantIndex) {
				// Keep the rest of the begin beat's own results: the begin
				// assistant may have made sibling calls whose results are still
				// needed for a valid tool-call/tool-result sequence.
				const message = result[index];
				if (
					message?.role === "toolResult" &&
					beginToolIds.has(message.toolCallId) &&
					message.toolCallId !== collapse.beginToolCallId
				) {
					next.push(message);
				}
				continue;
			}
			if (index <= endAssistantIndex) {
				next.push(result[index]);
				continue;
			}
			// Pin records move after the collapsed scope's end beat.
			if (result[index]?.role === "toolResult") {
				next.push(result[index]);
				continue;
			}
			flushPinned();
			next.push(result[index]);
		}
		flushPinned();
		result = next;
	}

	return result;
}

/** Return true when the begin receipt already shows this collapse's report. */
export function isCollapsed(messages, collapse) {
	const begin = findBegin(messages, collapse?.beginToolCallId);
	if (!begin) return false;
	return joinedText(begin.result) === finishedReport(collapse.report);
}

/** Return the exact text that reports a finished scope. */
export function finishedReport(report) {
	return `You have finished this scope. Here is your report: ${report}`;
}

export { isHandoffBoundary, crossesHandoffBoundary };
