// Transcript tail: vibe wording and the final user tail. Pure. No I/O.

const VIBE_WORKER_LINE = "drive two worker CLIs";
const VIBE_WORKER_REPLACEMENT =
	"direct as many parallel slice/swarm workers as causality allows";
const VIBE_CONCURRENCY_LINE =
	"Run sessions concurrently — normally one `fast` and one `good` on different workstreams.";
const VIBE_CONCURRENCY_REPLACEMENT =
	"Run independent workstreams concurrently. For decomposable work, use more and more workers aggressively.";

/** Apply the two vibe-mode wording updates to a custom message. */
export function rewriteVibeMessage(message) {
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

/** Append one final user message with a single text block. */
export function appendUserTail(messages, text) {
	const source = Array.isArray(messages) ? messages : [];
	return [
		...source,
		{
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	];
}
