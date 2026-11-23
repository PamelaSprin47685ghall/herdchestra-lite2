// Replay rendering: turn a child branch's messages into plain text.
//
// The parent reads the child's record through one tool result. Plain text
// keeps that legal for every provider: no duplicated tool-call pairing, no
// cross-model thinking signature, no reasoning item id. The record carries
// only what the child said and the names of the tools it called: arguments
// and results are the child's working noise, and the parent cannot act on
// them. This module is pure. It reads no clock and performs no I/O.

/**
 * Render a slice of one branch as the record the parent will read.
 *
 * options.start / options.end select the message range, [start, end).
 *
 * Every assistant text block becomes one line, verbatim. Every tool call
 * becomes a bare `[name]`, scope_context included: the parent does not read
 * the child's pins. Thinking blocks, tool results, tool arguments, user
 * broadcasts, and bookkeeping entries never reach the parent. Lines are
 * joined with `\n`.
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
				lines.push(`[${block.name}]`);
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


