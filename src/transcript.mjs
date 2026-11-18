/**
 * Pure transcript helpers. No I/O.
 *
 * Message shapes follow omp:
 * - assistant: { role, content, timestamp }
 * - toolResult: { role, toolCallId, toolName, content, isError, timestamp }
 * - user: { role, content, timestamp }
 * - custom: { role, customType, content, ... }
 */

const TOOL_CALL_TYPE = "toolCall";
const SCOPE_TOOL_NAME = "scope";
export const PIN_TOOL_NAME = "pin";

const VIBE_WORKER_LINE = "drive two worker CLIs";
const VIBE_WORKER_REPLACEMENT =
	"direct as many parallel slice/swarm workers as causality allows";
const VIBE_CONCURRENCY_LINE =
	"Run sessions concurrently — normally one `fast` and one `good` on different workstreams.";
const VIBE_CONCURRENCY_REPLACEMENT =
	"Run independent workstreams concurrently. For decomposable work, use more and more workers aggressively.";

function reject(code, reason) {
	return { ok: false, code, reason };
}

/** FNV-1a over UTF-16 code units. Returns 8 lowercase hex digits. */
function fnv1a(text) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** Join the text and thinking blocks in content order. */
function joinedText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block?.type === "text") parts.push(block.text ?? "");
		else if (block?.type === "thinking") parts.push(block.thinking ?? block.text ?? "");
	}
	return parts.join("\n");
}

/** Return the tool calls of a message. */
export function toolCalls(message) {
	if (!message || !Array.isArray(message.content)) return [];
	const calls = [];
	for (const block of message.content) {
		if (block?.type !== TOOL_CALL_TYPE) continue;
		calls.push({
			id: block.id,
			name: block.name,
			arguments: block.arguments,
		});
	}
	return calls;
}

/** Return a stable beat key for a message. */
export function beatKey(message) {
	const calls = toolCalls(message);
	if (calls.length > 0) {
		const ids = calls.map((call) => call.id).sort();
		return `tc:${ids.join(",")}`;
	}
	const timestamp = message?.timestamp ?? "";
	return `msg:${timestamp}:${fnv1a(joinedText(message))}`;
}

/** Return the beat of the assistant message at a given index. */
export function exitBeat(messages, assistantIndex) {
	const message = messages?.[assistantIndex];
	const calls = toolCalls(message);
	return {
		key: beatKey(message),
		toolCallIds: calls.map((call) => call.id),
		calls,
	};
}

/** Return the index of the assistant message that carries a tool call. */
export function findToolCallIndex(messages, toolCallId) {
	if (!Array.isArray(messages)) return -1;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (toolCalls(message).some((call) => call.id === toolCallId)) return index;
	}
	return -1;
}

/** Locate the scope begin call and its first result. */
export function findBegin(messages, beginToolCallId) {
	const assistantIndex = findToolCallIndex(messages, beginToolCallId);
	if (assistantIndex < 0) return null;
	for (let index = assistantIndex + 1; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role === "toolResult" && message.toolCallId === beginToolCallId) {
			return {
				assistantIndex,
				resultIndex: index,
				assistant: messages[assistantIndex],
				result: message,
			};
		}
	}
	return null;
}

/**
 * Find the nearest earlier beat that regret may remove.
 *
 * The current assistant message is in flight and is never a target.
 */
export function findRegretTarget(state, messages, currentAssistantIndex, scope) {
	if (!scope) return reject("OUTSIDE_SCOPE", "Regret requires an active scope.");
	if (!Array.isArray(messages) || messages.length === 0) {
		return reject("NO_BEAT", "The transcript has no assistant beat.");
	}

	const beginAssistantIndex = findToolCallIndex(messages, scope.beginToolCallId);
	if (beginAssistantIndex < 0) {
		return reject("SCOPE_BOUNDARY", "The scope begin message is not in the transcript.");
	}

	const regrets = new Set(Array.isArray(state?.regrets) ? state.regrets : []);
	const charges = state?.charges ?? {};
	const lastIndex = Math.min(currentAssistantIndex - 1, messages.length - 1);

	for (let index = lastIndex; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (regrets.has(beatKey(message))) continue;

		if (index <= beginAssistantIndex) {
			return reject("SCOPE_BOUNDARY", "The candidate is at or before the scope begin.");
		}

		const calls = toolCalls(message);
		if (calls.some((call) => call.name === SCOPE_TOOL_NAME)) {
			return reject("SCOPE_BOUNDARY", "A scope call is not a regret target.");
		}

		const foreign = calls.find((call) => {
			const charge = charges[call.id];
			return charge !== undefined && charge.scopeId !== scope.id;
		});
		if (foreign) {
			return reject("OUTSIDE_SCOPE", `Tool call ${foreign.id} belongs to another scope.`);
		}

		return { ok: true, beat: exitBeat(messages, index), toolCalls: calls };
	}

	return reject("NO_BEAT", "No earlier assistant beat remains in this scope.");
}

/** Remove the messages of every regretted beat. */
export function filterRegrets(messages, regrets) {
	const source = Array.isArray(messages) ? messages : [];
	const regretSet = new Set(Array.isArray(regrets) ? regrets : []);
	if (regretSet.size === 0) return source.slice();

	const droppedMessages = new Set();
	const droppedToolCallIds = new Set();
	for (const message of source) {
		if (message?.role !== "assistant" || !regretSet.has(beatKey(message))) continue;
		droppedMessages.add(message);
		for (const call of toolCalls(message)) droppedToolCallIds.add(call.id);
	}

	const kept = [];
	for (const message of source) {
		if (droppedMessages.has(message)) continue;
		if (message?.role === "toolResult" && droppedToolCallIds.has(message.toolCallId)) continue;
		kept.push(message);
	}
	return kept;
}

/**
 * Apply the scope-end history replacement for every collapsed record.
 *
 * A scope closes into a visible record. When its younger sibling closes, that
 * younger sibling marks this record `collapsed: true`; only then is its begin
 * receipt rewritten and its interior removed. The newest closed scope stays
 * fully visible until a younger sibling closes.
 */
function pinAssistantMessage(message) {
	const content = Array.isArray(message.content) ? message.content : [];
	return {
		...message,
		content: content.filter(
			(block) => block?.type !== TOOL_CALL_TYPE || block.name === PIN_TOOL_NAME,
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

export function applyCollapses(messages, collapses) {
	let result = Array.isArray(messages) ? messages.slice() : [];
	const records = Array.isArray(collapses) ? collapses : [];
	const active = records.filter((collapse) => collapse.collapsed !== false);

	for (const collapse of active) {
		const begin = findBegin(result, collapse.beginToolCallId);
		if (!begin) continue;

		const endAssistantIndex = findToolCallIndex(result, collapse.endToolCallId);
		if (endAssistantIndex < 0 || endAssistantIndex <= begin.resultIndex) continue;

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

/** Apply the two vibe-mode wording updates to a custom message. */
export function rewriteVibeMessage(message) {
	if (
		message?.role !== "custom" ||
		message.customType !== "vibe-mode-context" ||
		typeof message.content !== "string"
	) {
		return message;
	}

	const content = message.content
		.split(VIBE_WORKER_LINE)
		.join(VIBE_WORKER_REPLACEMENT)
		.split(VIBE_CONCURRENCY_LINE)
		.join(VIBE_CONCURRENCY_REPLACEMENT);
	return content === message.content ? message : { ...message, content };
}

/** Append one final user message with a single text block. */
export function appendUserTail(messages, text) {
	const source = Array.isArray(messages) ? messages : [];
	return [
		...source,
		{
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	];
}
