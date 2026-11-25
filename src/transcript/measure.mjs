// Transcript measure: one plain count of the characters a message sequence
// carries. Pure. No I/O, no clock.

/**
 * Count one message's payable characters.
 *
 * Deliberately not memoized. The count stringifies tool-call arguments and
 * reads each block, so the number of property reads is observable to a caller
 * that passes an accessor-backed object. A memory here would silently change
 * that read pattern, so callers that must avoid a repeated walk (prefix
 * lengths) use `prefixChars` instead of a cache.
 */
export function messageChars(message) {
	if (!message || typeof message !== "object") return 0;
	const content = message.content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text") chars += String(block.text ?? "").length;
		else if (block.type === "thinking") {
			chars += String(block.thinking ?? block.text ?? "").length;
		} else if (block.type === "toolCall") {
			const args = block.arguments;
			chars += typeof args === "string" ? args.length : JSON.stringify(args ?? {}).length;
		}
	}
	return chars;
}

/**
 * Count the payable characters of a message sequence.
 *
 * This is a text-unit count, not UTF-8 bytes and not tokens: Chinese text,
 * emoji and escapes all cost one per UTF-16 unit. Callers that need bytes or
 * tokens convert elsewhere, so no caller has to guess which unit it holds.
 */
export function sliceChars(messages) {
	let chars = 0;
	for (const message of Array.isArray(messages) ? messages : []) {
		if (!message || typeof message !== "object") continue;
		chars += messageChars(message);
	}
	return chars;
}

/**
 * Characters in `messages[0..end)`.
 *
 * Identical in result and in read order to
 * `sliceChars(messages.slice(0, end))`, without building the prefix array.
 * `end` follows `Array.prototype.slice` exactly: absent means the whole list,
 * negative counts from the end, and a non-finite bound reads nothing. A
 * sequence measure pays Θ(characters); the copy it used to pay Θ(elements)
 * allocation on top of that, on every assistant message.
 */
export function prefixChars(messages, end) {
	const list = Array.isArray(messages) ? messages : [];
	const bound = end === undefined ? list.length : Number(end);
	const stop = Number.isFinite(bound)
		? Math.min(list.length, bound < 0 ? Math.max(0, list.length + bound) : bound)
		: 0;
	let chars = 0;
	for (let index = 0; index < stop; index += 1) {
		const message = list[index];
		if (!message || typeof message !== "object") continue;
		chars += messageChars(message);
	}
	return chars;
}
