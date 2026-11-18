// Station message helpers: argument parsing and transcript keys. Pure.

import { toolCalls } from "../transcript/index.mjs";

const CONTROL_TOOLS = new Set(["scope", "regret", "defer", "pin"]);

function parseArgs(call) {
	const raw = call?.arguments;
	if (raw && typeof raw === "object") return raw;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}
	return {};
}

function trimText(value) {
	return typeof value === "string" ? value.trim() : "";
}

function controlsIn(message) {
	return toolCalls(message).filter((call) => CONTROL_TOOLS.has(call.name));
}

function processedKey(calls) {
	return calls
		.map((call) => call.id)
		.sort()
		.join(",");
}

function cloneMessage(message) {
	if (!message || typeof message !== "object") return message;
	return {
		...message,
		...(Array.isArray(message.content)
			? {
					content: message.content.map((block) =>
						block && typeof block === "object" ? { ...block } : block,
					),
				}
			: {}),
	};
}

function finishedResultMessage(toolCallId, report, finishedReport) {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "scope",
		content: [{ type: "text", text: finishedReport(report) }],
		isError: false,
		timestamp: Date.now(),
	};
}

function tailKey(message) {
	if (!message || typeof message !== "object") return "";
	if (message.role === "toolResult") return `toolResult:${message.toolCallId}`;
	if (message.role === "assistant") {
		return `assistant:${message.timestamp ?? 0}:${toolCalls(message).map((call) => call.id).sort().join(",")}`;
	}
	if (message.role === "user") {
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.map((block) => (block?.type === "text" ? block.text : "")).join("")
				: "";
		return `user:${text.slice(0, 80)}`;
	}
	return `${message.role}:${message.customType ?? ""}`;
}

function hostBoundaryKey(messages) {
	if (!Array.isArray(messages)) return null;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.role !== "custom") continue;
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
		if (
			message.customType === "handoff" ||
			message.customType === "herd-relay-handoff" ||
			text.includes("<handoff-context>")
		) {
			return `${message.customType ?? ""}:${message.timestamp ?? ""}:${text.length}`;
		}
	}
	return null;
}

function sameTail(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return false;
	return tailKey(a[a.length - 1]) === tailKey(b[b.length - 1]);
}

export {
	CONTROL_TOOLS,
	parseArgs,
	trimText,
	controlsIn,
	processedKey,
	cloneMessage,
	finishedResultMessage,
	tailKey,
	hostBoundaryKey,
	sameTail,
};
