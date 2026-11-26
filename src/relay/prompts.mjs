// Relay prompts: keep the user's own words across a rewind.
//
// A Root rewind compacts the branch to a clean rebirth. Any user prompt or
// user steer that only lived in the discarded transcript would vanish unless
// archived here and restored as real user messages after the compaction.
// Pure. No I/O.

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block?.type === "text") parts.push(String(block.text ?? ""));
	}
	return parts.join("\n");
}

/** True only for a genuine user-authored prompt or user steer. */
export function isRealUserMessage(message) {
	if (!message || message.role !== "user") return false;
	if (message.herdSkill === true || message.excludeFromContext === true) return false;
	if (message.attribution === "agent" || message.synthetic === true) return false;
	return true;
}

function promptText(message) {
	if (!isRealUserMessage(message)) return "";
	return textOfContent(message.content);
}

/**
 * The user's own prompts and steers in `messages`, oldest first.
 *
 * Agent-authored messages (`attribution: "agent"`, `synthetic: true`,
 * `herdSkill: true`, `excludeFromContext: true`) are excluded automatically.
 * `options.exclude` may additionally filter legacy texts that lacked metadata.
 */
export function collectUserPrompts(messages, options = {}) {
	const source = Array.isArray(messages) ? messages : [];
	const exclude = options.exclude instanceof Set ? options.exclude : new Set();
	const prompts = [];
	for (const message of source) {
		const text = promptText(message);
		if (text.trim() === "" || exclude.has(text) || exclude.has(text.trim())) continue;
		prompts.push(text);
	}
	return prompts;
}

function cleanPrompts(values) {
	const out = [];
	for (const value of Array.isArray(values) ? values : []) {
		if (typeof value !== "string") continue;
		if (value.trim() !== "") out.push(value);
	}
	return out;
}

/**
 * Merge the archive with the prompts still visible in the current context.
 *
 * The visible list is normally a suffix of the archive (older prompts were
 * compacted away, or replayed verbatim after a rewind). Matching the longest
 * suffix-prefix overlap keeps one chronological order without duplicating a
 * prompt that is both archived and live, while still preserving genuine
 * repeated user prompts.
 */
export function mergeUserPrompts(archive, fresh) {
	const kept = cleanPrompts(archive);
	const added = cleanPrompts(fresh);
	if (added.length === 0) return kept;
	const limit = Math.min(kept.length, added.length);
	for (let overlap = limit; overlap > 0; overlap -= 1) {
		let same = true;
		for (let index = 0; index < overlap; index += 1) {
			if (kept[kept.length - overlap + index] !== added[index]) {
				same = false;
				break;
			}
		}
		if (same) return [...kept, ...added.slice(overlap)];
	}
	const counts = new Map();
	for (const text of kept) counts.set(text, (counts.get(text) ?? 0) + 1);
	const out = kept.slice();
	for (const text of added) {
		const remaining = counts.get(text) ?? 0;
		if (remaining > 0) {
			counts.set(text, remaining - 1);
			continue;
		}
		out.push(text);
	}
	return out;
}

/** Build persisted user messages from the verbatim user-prompt archive. */
export function rebornUserMessages(userPrompts, timestamp = Date.now()) {
	const prompts = cleanPrompts(userPrompts);
	return prompts.map((text, index) => ({
		role: "user",
		content: [{ type: "text", text }],
		attribution: "user",
		timestamp: timestamp + index,
	}));
}
