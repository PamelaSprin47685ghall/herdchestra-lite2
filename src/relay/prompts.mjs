// Relay prompts: keep the user's own words across a handoff.
//
// A handoff commits a compaction, and the successor starts from that summary.
// Any user prompt the summary omits is gone. The archive collected here is the
// requirement record that survives every generation. Pure. No I/O.

function promptText(message) {
	if (!message || message.role !== "user") return "";
	if (message.excludeFromContext === true) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block?.type === "text") parts.push(String(block.text ?? ""));
	}
	return parts.join("\n");
}

/**
 * The user's own prompts in `messages`, oldest first.
 *
 * options.exclude names texts the relay itself delivered (the handoff demand,
 * the blocked-tool reason). They are instructions for one generation, not
 * requirements, so a successor must not inherit them as user prompts.
 */
export function collectUserPrompts(messages, options = {}) {
	const source = Array.isArray(messages) ? messages : [];
	const exclude = options.exclude instanceof Set ? options.exclude : new Set();
	const prompts = [];
	for (const message of source) {
		const text = promptText(message).trim();
		if (text === "" || exclude.has(text)) continue;
		prompts.push(text);
	}
	return prompts;
}

function cleanPrompts(values) {
	const out = [];
	for (const value of Array.isArray(values) ? values : []) {
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (text !== "") out.push(text);
	}
	return out;
}

/**
 * Merge the archive with the prompts still visible in the current context.
 *
 * The visible list is normally a suffix of the archive (older prompts were
 * compacted away). Matching that suffix first keeps one chronological order
 * and never duplicates a prompt that is both archived and still present.
 * Without a shared suffix the archive stays first, and only prompts whose
 * occurrence the archive does not already hold are appended.
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
