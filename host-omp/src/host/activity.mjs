// Pure helpers for host transcript events.
//
// They read events, never a session, and know nothing about the scope model:
// labels and the status row come from `engine.scopes`.

export function stripToolCalls(event) {
	const message = event?.message;
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return event;
	const kept = message.content.filter((block) => block?.type !== "toolCall");
	return kept.length === message.content.length ? event : { ...event, message: { ...message, content: kept } };
}

export function textBlocks(content, type, field) {
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => block.type === type && block[field]?.trim() ? [block[field]] : []).join("\n");
}

export function toolSummaryText(event) {
	if (event.type === "tool_execution_end") {
		const output = textBlocks(event.result?.content, "text", "text");
		return `${event.toolName} · ${event.isError ? "failed" : "completed"}${output ? `\n${output}` : ""}`;
	}
	return `${event.toolName} · running`;
}

export function formatFallbackLine(entry, now) {
	const elapsed = Math.max(0, Math.floor((now - entry.startedAt) / 1000));
	const title = entry.definition?.label ?? entry.toolName;
	const prefix = entry.label ? `${entry.label} ` : "";
	const tail = entry.partialText ? ` · ${entry.partialText}` : " · running";
	return `${prefix}• ${title}${tail} ${elapsed}s`;
}

const TOOL_TARGET_FIELDS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "scopeId", "target", "name"];

export function assistantParts(message, assistantMessageEvent) {
	const content = Array.isArray(message?.content) && message.content.length > 0
		? message.content
		: assistantMessageEvent?.partial?.content;
	if (!Array.isArray(content)) return [];
	const parts = [];
	for (const block of content) {
		if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
			parts.push({ kind: "thinking", text: block.thinking });
		} else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
			parts.push({ kind: "text", text: block.text });
		}
	}
	return parts;
}

export function formatToolTarget(_toolName, args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	for (const field of TOOL_TARGET_FIELDS) {
		const value = args[field];
		if (typeof value !== "string" || !value.trim()) continue;
		const line = value.replace(/\s+/g, " ").trim();
		return line.length > 80 ? `${line.slice(0, 79)}…` : line;
	}
	return "";
}

export function formatToolOutput(result) {
	if (typeof result === "string") return result.trimEnd();
	if (!result || typeof result !== "object") return "";
	if (typeof result.text === "string" && result.text.trim()) return result.text.trimEnd();
	return textBlocks(result.content, "text", "text").trimEnd();
}

export function partsText(parts) {
	return parts.map((part) => part.text).join("\n");
}

export function partsSignature(parts) {
	return parts.map((part) => `${part.kind}:${part.text}`).join("\0");
}
