// Replay rendering: turn a child branch's messages into plain text.
//
// The parent reads the child's record through one tool result. Plain text
// keeps that legal for every provider: no duplicated tool-call pairing, no
// cross-model thinking signature, no reasoning item id. The record carries
// what the child said and one line per tool call, arguments included: the
// parent can re-run the call from the record alone. Results are the child's
// working noise. This module is pure. It reads no clock and performs no I/O.

/** Compact JSON for one argument value; `undefined` stays readable. */
function attribute(value) {
	return value === undefined ? "undefined" : JSON.stringify(value);
}

/**
 * One tool call as one line: `name(key="value", key2=json)`.
 *
 * Pug-like attributes, in the order the arguments object already has. A
 * string is a JSON-quoted literal, so a newline stays `\n` and the call stays
 * on one line. Every other value is compact JSON, so a nested object keeps
 * its shape without a second line. Nothing is sliced, filtered, or capped.
 */
function callLine(name, args) {
	const label = String(name ?? "");
	if (args === undefined || args === null) return `${label}()`;
	if (typeof args !== "object" || Array.isArray(args)) {
		return `${label}(${attribute(args)})`;
	}
	const keys = Object.keys(args);
	if (keys.length === 0) return `${label}()`;
	return `${label}(${keys.map((key) => `${key}=${attribute(args[key])}`).join(", ")})`;
}

/**
 * Render a slice of one branch as the record the parent will read.
 *
 * options.start / options.end select the message range, [start, end).
 *
 * Every assistant text block becomes one line, verbatim. Every tool call
 * becomes one `name(...)` line, scope_context included: a pin reaches the
 * parent as its arguments, like any other call. Thinking blocks, tool
 * results, user broadcasts, and bookkeeping entries never reach the parent.
 * Lines are joined with `\n`.
 */
export function renderChildRecord(messages, options = {}) {
	const source = Array.isArray(messages) ? messages : [];
	const start = Number.isInteger(options.start) ? Math.max(0, options.start) : 0;
	const end = Number.isInteger(options.end)
		? Math.min(source.length, options.end)
		: source.length;
	const lines = [];
	for (let index = start; index < end; index += 1) {
		const message = source[index];
		if (!message || typeof message !== "object") continue;
		if (message.role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : [];
			for (const block of content) {
				if (block?.type === "text") {
					const text = String(block.text ?? "").trim();
					if (text !== "") lines.push(text);
					continue;
				}
				if (block?.type !== "toolCall") continue;
				lines.push(callLine(block.name, block.arguments));
			}
			continue;
		}
		// Tool results and custom entries describe work done, not work said.
		// The parent acts on the child's words and needs no replay of them.
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
}) {
	const header = failed
		? `[Record from forked scope — fork ${forkId}, failed: ${reason ?? "unknown reason"}]`
		: `[Record from forked scope — fork ${forkId}]`;
	const preamble = failed
		? "History only; do not re-execute it or treat its conclusions as verified."
		: "History only; do not re-execute it.";
	const tail = `[End of record from forked scope — fork ${forkId}]`;
	const count = remaining.length;
	const note =
		count > 0
			? `Unreceived: ${count} (${remaining.join(", ")}). Call scope_join again to take the next one.`
			: "Unreceived: 0.";
	const body = record && record.trim() !== "" ? record.trim() : "(no output)";
	return [header, preamble, "", body, "", tail, note].join("\n").trim();
}


