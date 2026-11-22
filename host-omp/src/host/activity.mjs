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

export function assistantParts(message) {
	if (!Array.isArray(message?.content)) return [];
	const parts = [];
	for (const block of message.content) {
		if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
			parts.push({ kind: "thinking", text: block.thinking });
		} else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
			parts.push({ kind: "text", text: block.text });
		}
	}
	return parts;
}

export function partsText(parts) {
	return parts.map((part) => part.text).join("\n");
}

export function partsSignature(parts) {
	return parts.map((part) => `${part.kind}:${part.text}`).join("\0");
}
