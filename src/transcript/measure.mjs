// Transcript measure: one plain count of the characters a message sequence
// carries. Pure. No I/O, no clock.

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
		const content = message.content;
		if (typeof content === "string") {
			chars += content.length;
		} else if (Array.isArray(content)) {
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
		}
	}
	return chars;
}
