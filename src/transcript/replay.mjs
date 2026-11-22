// Replay rendering: turn a child branch's messages into plain text.
//
// The parent reads the child's record through one tool result. Plain text
// keeps that legal for every provider: no duplicated tool-call pairing, no
// cross-model thinking signature, no reasoning item id. This module is pure.
// It reads no clock and performs no I/O.

import { targetsText, validTargets } from "../scope/targets.mjs";

const CHILD_SCOPE_TOOLS = new Set(["scope_join", "scope_return"]);
const PIN_TOOL = "pin";
const FORK_TOOL = "scope_fork";

const DEFAULT_MAX_RESULT_CHARS = 2000;
const DEFAULT_MAX_THINKING_CHARS = 4000;

function tab(level) {
	return "  ".repeat(Math.max(0, level));
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block?.type === "text") parts.push(String(block.text ?? ""));
		else if (block?.type === "thinking") {
			parts.push(String(block.thinking ?? block.text ?? ""));
		}
	}
	return parts.join("\n");
}

function truncate(text, limit, label) {
	const value = String(text ?? "");
	if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value;
	return `${value.slice(0, limit)}\n… (${value.length - limit} chars omitted${label ? `, ${label}` : ""})`;
}

function argumentsText(args) {
	if (typeof args === "string") return args;
	if (args === undefined || args === null) return "{}";
	try {
		return JSON.stringify(args);
	} catch {
		return "{}";
	}
}

function pinLine(args) {
	let value = args;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return `[pin] ${value}`;
		}
	}
	if (!value || typeof value !== "object") return `[pin] ${argumentsText(args)}`;
	const parts = [];
	for (const key of ["assumption", "deduction", "induction", "finding", "conclusion"]) {
		if (typeof value[key] === "string" && value[key].trim() !== "") {
			parts.push(`${key}: ${value[key].trim()}`);
		}
	}
	return parts.length > 0 ? `[pin] ${parts.join(" | ")}` : "[pin]";
}

/** Split one fork call into the items it registered. */
function forkItems(args) {
	let value = args;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object") return null;
	if (Array.isArray(value.forks)) return value.forks;
	// A single item may arrive unwrapped in transcripts written before the
	// batch schema. Reading it costs nothing and keeps old records legible.
	if (typeof value.intent === "string") return [value];
	return null;
}

function budgetPhrase(budget) {
	if (!budget || typeof budget !== "object") return "none";
	const parts = [];
	for (const key of Object.keys(budget)) parts.push(`${key} ${budget[key]}`);
	return parts.length > 0 ? parts.join(", ") : "none";
}

/** The id a parent joins by. A batch suffixes the call id with its index. */
function forkIdOf(callId, count, index) {
	if (typeof callId !== "string" || callId === "") return null;
	return count === 1 ? callId : `${callId}:${index}`;
}

/**
 * Render one fork call as one structural line per item.
 *
 * A left bracket never folds, so this line is the only surviving record of
 * what the branch declared: the fork id the parent joins by, the task, and
 * the admission arguments. Compressing it to the bare intent would leave a
 * shortened receipt that no longer explains where a grandchild came from.
 */
function forkLines(args, callId) {
	const items = forkItems(args);
	if (items === null || items.length === 0) return ["(forked a child)"];
	const lines = [];
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index] && typeof items[index] === "object" ? items[index] : {};
		const id = item.scopeId ?? forkIdOf(callId, items.length, index);
		const fields = [];
		if (item.blocked === true) fields.push("blocked");
		const intent = typeof item.intent === "string" ? item.intent.trim() : "";
		fields.push(`intent: "${intent}"`);
		fields.push(`budget: ${budgetPhrase(item.budget)}`);
		if (typeof item.time === "number" && Number.isFinite(item.time)) {
			fields.push(`time: ${item.time}s`);
		}
		if (validTargets(item.targets)) {
			fields.push(`targets: ${targetsText(item.targets)}`);
		}
		if (typeof item.model === "string" && item.model.trim() !== "") {
			fields.push(`model: ${item.model.trim()}`);
		}
		lines.push(`${id === null ? "[fork]" : `[fork ${id}]`} ${fields.join(" | ")}`);
	}
	return lines;
}

function foldedReport(folded, toolCallId) {
	if (!folded) return null;
	if (typeof folded.get === "function") {
		const value = folded.get(toolCallId);
		return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
	}
	const value = folded[toolCallId];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Render a slice of one branch as the record the parent will read.
 *
 * options:
 * - start / end: message range, [start, end)
 * - maxResultChars / maxThinkingChars: truncation limits
 * - folded: Map or object of right-bracket toolCallId to its summary
 * - skipToolCallIds: calls withdrawn by amend, plus ledger calls
 * - toolNames: extra toolCallId to name map for results whose message omits it
 */
export function renderChildRecord(messages, options = {}) {
	const source = Array.isArray(messages) ? messages : [];
	const start = Number.isInteger(options.start) ? Math.max(0, options.start) : 0;
	const end = Number.isInteger(options.end)
		? Math.min(source.length, options.end)
		: source.length;
	const maxResultChars = Number.isFinite(options.maxResultChars)
		? options.maxResultChars
		: DEFAULT_MAX_RESULT_CHARS;
	const maxThinkingChars = Number.isFinite(options.maxThinkingChars)
		? options.maxThinkingChars
		: DEFAULT_MAX_THINKING_CHARS;
	const folded = options.folded ?? null;
	const skip = options.skipToolCallIds instanceof Set ? options.skipToolCallIds : new Set();
	const names = new Map();
	if (options.toolNames instanceof Map) {
		for (const [key, value] of options.toolNames) names.set(key, value);
	}
	const lines = [];
	for (let index = start; index < end; index += 1) {
		const message = source[index];
		if (!message || typeof message !== "object") continue;
		if (message.role === "user") {
			const text = textOf(message.content).trim();
			if (text !== "") lines.push(`[user] ${truncate(text, maxResultChars)}`);
			continue;
		}
		if (message.role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : [];
			for (const block of content) {
				if (block?.type === "text") {
					const text = String(block.text ?? "").trim();
					if (text !== "") lines.push(text);
					continue;
				}
				if (block?.type === "thinking") {
					const thinking = String(block.thinking ?? block.text ?? "").trim();
					if (thinking !== "") {
						lines.push(`[thinking] ${truncate(thinking, maxThinkingChars)}`);
					}
					continue;
				}
				if (block?.type !== "toolCall") continue;
				if (skip.has(block.id)) continue;
				names.set(block.id, block.name);
				if (block.name === PIN_TOOL) {
					lines.push(pinLine(block.arguments));
					continue;
				}
				if (block.name === FORK_TOOL) {
					for (const line of forkLines(block.arguments, block.id)) lines.push(line);
					continue;
				}
				if (CHILD_SCOPE_TOOLS.has(block.name)) continue;
				lines.push(`[call ${block.name}] ${truncate(argumentsText(block.arguments), maxResultChars)}`);
			}
			continue;
		}
		if (message.role === "toolResult") {
			const id = message.toolCallId;
			if (skip.has(id)) continue;
			const name = message.toolName ?? names.get(id) ?? "tool";
			if (name === PIN_TOOL) continue;
			// The child's own fork receipt is already one line above.
			if (name === FORK_TOOL) continue;
			if (CHILD_SCOPE_TOOLS.has(name)) {
				const report = foldedReport(folded, id);
				if (report !== null) {
					lines.push(`[result ${name}] folded scope: ${report}`);
				} else {
					const text = textOf(message.content).trim();
					if (text !== "") {
						lines.push(`[result ${name}] ${truncate(text, maxResultChars)}`);
					}
				}
				continue;
			}
			const text = textOf(message.content).trim();
			if (text === "") continue;
			const prefix = message.isError === true ? "[result error]" : `[result ${name}]`;
			lines.push(`${prefix} ${truncate(text, maxResultChars)}`);
			continue;
		}
		// Custom and ledger entries describe bookkeeping, not work. Skip them.
	}
	return lines.join("\n");
}

/** Character count of a rendered record. Used for accounting, not display. */
export function recordChars(text) {
	return typeof text === "string" ? text.length : 0;
}

/**
 * Build the join receipt the parent reads. Kept here so the wording of a
 * child record has exactly one home.
 */
export function joinReceipt({
	forkId,
	record,
	failed = false,
	reason = null,
	remaining = [],
	pendingReceipt = null,
}) {
	const header = failed
		? `[Child record — fork ${forkId}, failed: ${reason ?? "unknown reason"}]`
		: `[Child record — fork ${forkId}]`;
	const preamble = failed
		? "History only; do not re-execute it or treat its conclusions as verified."
		: "History only; do not re-execute it.";
	const tail = `[End of child record — fork ${forkId}]`;
	const count = remaining.length;
	let note = "Unreceived: 0.";
	if (count > 0) {
		const ids = remaining.join(", ");
		const report = typeof pendingReceipt === "string" && pendingReceipt !== ""
			? `an elder_report for receipt ${pendingReceipt}`
			: "elder_report: null";
		note = `Unreceived: ${count} (${ids}). Call scope_join again with ${report}.`;
	}
	const body = record && record.trim() !== "" ? record.trim() : "(the child produced no messages)";
	return [
		header,
		preamble,
		"",
		body,
		"",
		tail,
		note,
	]
		.join("\n")
		.trim();
}

export { CHILD_SCOPE_TOOLS, DEFAULT_MAX_RESULT_CHARS, DEFAULT_MAX_THINKING_CHARS, tab };
