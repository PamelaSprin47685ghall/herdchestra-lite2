/**
 * Transcript messages: message shapes and lookup helpers. No I/O.
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

export { TOOL_CALL_TYPE, SCOPE_TOOL_NAME, reject, fnv1a, joinedText };
