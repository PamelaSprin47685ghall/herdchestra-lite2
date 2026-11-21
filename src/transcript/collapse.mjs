/**
 * Fork/join receipt projection. Pure. No I/O, no clock.
 *
 * A right bracket's text may be replaced by the summary a later join supplied.
 * Nothing else changes: the left bracket stays in place with its arguments,
 * the youngest receipt keeps its full record, and no message is removed. A
 * nested fork line carried inside the receipt is copied into the shortened
 * text, so a grandchild's fork id survives the fold.
 */

const FOLDED_HEADER = "OK. Fork ";
const FOLDED_MARKER = "Child record folded.";
const NESTED_FORKS_HEADER = "Nested forks:";
const PINNED_HEADER = "Pinned:";
const FORK_LINE = /^(?:- )?\[fork(?:\s[^\]]*)?\]/;
const PIN_LINE = /^\[pin\](?:\s|$)/;

function resultText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block?.type === "text") parts.push(String(block.text ?? ""));
	}
	return parts.join("\n");
}

/**
 * Fork lines carried inside a receipt's text.
 *
 * A receipt is a child's record, and that record may itself contain a fork
 * the child opened. Replacing the prose with a summary must not delete the
 * grandchild's fork id and declaration.
 */
export function extractForkLines(text) {
	const value = typeof text === "string" ? text : "";
	const out = [];
	for (const line of value.split("\n")) {
		const trimmed = line.trim();
		const bare = trimmed.startsWith("- ") ? trimmed.slice(2) : trimmed;
		if (FORK_LINE.test(bare)) out.push(bare);
	}
	return out;
}

/** Pin lines carried inside a receipt's text. A pin is a conclusion the
 * parent still needs after the prose is shortened, so the short projection
 * keeps the pin line itself.
 */
export function extractPinnedLines(text) {
	const value = typeof text === "string" ? text : "";
	const out = [];
	for (const line of value.split("\n")) {
		const trimmed = line.trim();
		if (PIN_LINE.test(trimmed)) out.push(trimmed);
	}
	return out;
}

/** Build the shortened text a folded right bracket keeps. */
export function foldedScopeText(record, forkText = "", pinText = "") {
	const forkId = typeof record?.forkId === "string" ? record.forkId : "unknown";
	const report = typeof record?.report === "string" ? record.report.trim() : "";
	const parts = [`${FOLDED_HEADER}${forkId} joined. ${FOLDED_MARKER}`];
	if (report !== "") parts.push("", report);
	const pins = typeof pinText === "string" ? pinText.trim() : "";
	if (pins !== "") parts.push("", PINNED_HEADER, pins);
	const forks = typeof forkText === "string" ? forkText.trim() : "";
	if (forks !== "") parts.push("", NESTED_FORKS_HEADER, forks);
	return parts.join("\n");
}

/**
 * Project fork/join receipts onto one outbound message list.
 *
 * A right bracket whose record was folded keeps its position, its tool-call
 * id, and its left bracket. Only its text is replaced.
 *
 * Returns `{ messages, collapsed }`; `collapsed` lists the receipt ids this
 * pass shortened, so the caller can persist that fact.
 */
export function applyReceiptFolds(messages, receipts, options = {}) {
	const source = Array.isArray(messages) ? messages : [];
	const foldable = Array.isArray(options.foldable) ? options.foldable : [];
	if (foldable.length === 0) return { messages: source, collapsed: [] };

	const byClose = new Map(foldable.map((entry) => [entry.closeToolCallId, entry]));
	const collapsed = [];
	const out = source.map((message) => {
		if (message?.role !== "toolResult") return message;
		const entry = byClose.get(message.toolCallId);
		if (!entry) return message;
		const originalText = resultText(message);
		const report = typeof entry.report === "string" ? entry.report.trim() : "";
		// HOLD: a report that cannot shorten the record is archive material, not
		// a projection. This also leaves an already-short folded text untouched,
		// so a second pass never lengthens a receipt.
		if (report === "") return message;
		if (originalText.startsWith(FOLDED_HEADER) && originalText.includes(FOLDED_MARKER)) {
			return message;
		}
		// A failure's own words are the evidence the parent needs. A summary must
		// never turn a failed join into a successful-looking receipt.
		if (message.isError === true) return message;
		const forkText = extractForkLines(originalText)
			.map((line) => `- ${line}`)
			.join("\n");
		const pinText = extractPinnedLines(originalText).join("\n");
		const text = foldedScopeText(
			{ forkId: entry.scopeId ?? entry.forkToolCallId, report: entry.report },
			forkText,
			pinText,
		);
		// HOLD unless the whole projection is shorter than the record. The
		// header, the blank lines, the pins and the nested fork lines all cost
		// characters, so a shorter report alone is not a net gain.
		if (text.length >= originalText.length) return message;
		collapsed.push(entry.closeToolCallId);
		return { ...message, content: [{ type: "text", text }] };
	});
	if (collapsed.length === 0) return { messages: source, collapsed };
	return { messages: out, collapsed };
}

export { FOLDED_MARKER, FOLDED_HEADER };
