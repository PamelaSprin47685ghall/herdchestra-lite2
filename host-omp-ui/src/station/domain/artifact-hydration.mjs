// Artifact projection: which branch entries can contribute a file path, and how
// to project them without building the whole transcript.
//
// The artifact list describes the whole branch, but only a message that carries
// a tool call can contribute one. Reading the branch in contiguous runs keeps
// the pairing maps of `reconstructRange` per run instead of per message.

import { createArtifactCollector } from "./tool-artistry.mjs";
import { reconstructRange } from "./transcript-model.mjs";

// Hydration projects artifacts in contiguous runs, never one ordinal at a time.
// The bound keeps a run's projection (and its pairing maps) small while still
// amortizing the per-call allocation across many messages.
export const HYDRATE_ARTIFACT_CHUNK = 256;

// Artifacts describe the whole branch, so hydration has to read all of it — but
// only the entries that can contribute to the list. The predicate is the exact
// condition under which a projected message can hold a tool-call block:
//
//   blocks come from `blocksOf(content)`, whose only tool-call branch is
//   `block.type === "toolCall"` — no alias, no case folding, and `cleanBlocks`
//   only strips ANSI, never dropping a block. So a message has a tool-call
//   block exactly when its content array carries one of that type.
//
// The three execution roles below build their blocks without reading content
// (`bashExecution`, `pythonExecution`) or carry no blocks at all
// (`fileMention`), so a tool call inside their content could never reach the
// list.
export function mayCarryToolCall(entry) {
	const message = entry?.message;
	if (!message) return false;
	const role = message.role;
	if (role === "bashExecution" || role === "pythonExecution" || role === "fileMention") return false;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (block?.type === "toolCall") return true;
	}
	return false;
}

/**
 * The artifact list for a whole branch.
 *
 * The branch is the source of truth, so the list is built from every entry that
 * can contribute; the messages in the live window are not consulted, and a file
 * written an hour ago is still listed. Only candidates are projected, in runs,
 * so a long session costs the tool calls rather than the whole transcript.
 */
export function collectArtifacts({ entries, index, chunk = HYDRATE_ARTIFACT_CHUNK }) {
	const collector = createArtifactCollector();
	const list = entries ?? [];
	const total = index ? index.entryOfMessage.length : 0;
	let runStart = -1;
	const projectRun = (end) => {
		const built = reconstructRange(list, runStart, end, index);
		collector.add(
			built
				.filter(
					(message) =>
						message.role === "toolResult" ||
						message.blocks?.some((block) => block.type === "toolCall"),
				)
				.map((message) => ({
					toolCall: message.blocks?.find((block) => block.type === "toolCall"),
					toolResult: message.role === "toolResult" ? message : undefined,
				})),
		);
		runStart = -1;
	};
	for (let ordinal = 0; ordinal < total; ordinal += 1) {
		if (!mayCarryToolCall(list[index.entryOfMessage[ordinal]])) {
			if (runStart >= 0) projectRun(ordinal);
			continue;
		}
		if (runStart >= 0 && ordinal - runStart >= chunk) projectRun(ordinal);
		if (runStart < 0) runStart = ordinal;
	}
	if (runStart >= 0) projectRun(total);
	return collector.list();
}
