// Rewrite vibe wording on outbound messages. Pure after load.
//
// The replacement lines live in `resources/prompts/vibe-mode.md` and are read
// once at module scope, like every other prompt document. Spelling them here
// instead would give the same two sentences two owners, and a copy of prose
// drifts silently: the rewrite would keep emitting the old wording while the
// document said something else.

import { loadDoc } from "../prompts/index.mjs";

const VIBE = loadDoc("vibe-mode");
const VIBE_WORKER_LINE = "drive two worker CLIs";
const VIBE_WORKER_REPLACEMENT = VIBE.workers;
const VIBE_CONCURRENCY_LINE =
	"Run sessions concurrently — normally one `fast` and one `good` on different workstreams.";
const VIBE_CONCURRENCY_REPLACEMENT = VIBE.concurrent;

/** Apply the two vibe-mode wording updates to a custom message. */
export function rewriteVibeMessage(message, options = {}) {
	if (options?.vibeCompat === "off") return message;
	if (
		message?.role !== "custom" ||
		message.customType !== "vibe-mode-context" ||
		typeof message.content !== "string"
	) {
		return message;
	}

	const content = message.content
		.split(VIBE_WORKER_LINE)
		.join(VIBE_WORKER_REPLACEMENT)
		.split(VIBE_CONCURRENCY_LINE)
		.join(VIBE_CONCURRENCY_REPLACEMENT);
	return content === message.content ? message : { ...message, content };
}

