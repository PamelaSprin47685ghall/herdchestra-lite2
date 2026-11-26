// Pure helpers for host transcript events.
//
// They read events, never a session, and know nothing about the scope model:
// labels and the status row come from `engine.scopes`.

const ZERO_USAGE = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: Object.freeze({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	}),
});

export function stripToolCalls(event) {
	const message = event?.message;
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return event;
	const kept = message.content.filter((block) => block?.type !== "toolCall");
	return kept.length === message.content.length ? event : { ...event, message: { ...message, content: kept } };
}

export function textBlocks(content, type, field) {
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => block?.type === type && block[field]?.trim() ? [block[field]] : []).join("\n");
}

export function formatFallbackLine(entry, now) {
	const elapsed = Math.max(0, Math.floor((now - entry.startedAt) / 1000));
	const title = entry.definition?.label ?? entry.toolName;
	const prefix = entry.label ? `${entry.label} ` : "";
	const tail = entry.partialText ? ` · ${entry.partialText}` : " · running";
	return `${prefix}• ${title}${tail} ${elapsed}s`;
}

function appendDelta(base, delta) {
	if (!delta) return base;
	if (!base) return delta;
	return delta.startsWith(base) ? delta : `${base}${delta}`;
}

function cloneBlocks(blocks) {
	const next = new Map();
	if (blocks instanceof Map) {
		for (const [index, block] of blocks.entries()) {
			next.set(index, { kind: block.kind, text: block.text });
		}
	}
	return next;
}

function extractIndexedBlocks(content) {
	const blocks = new Map();
	if (!Array.isArray(content)) return blocks;
	for (let index = 0; index < content.length; index += 1) {
		const block = content[index];
		if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
			blocks.set(index, { kind: "thinking", text: block.thinking });
		} else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
			blocks.set(index, { kind: "text", text: block.text });
		}
	}
	return blocks;
}

function projectParts(blocks) {
	const indices = [...blocks.keys()].sort((a, b) => a - b);
	const parts = [];
	for (const index of indices) {
		const block = blocks.get(index);
		if (block && block.text.trim()) {
			parts.push({ kind: block.kind, text: block.text });
		}
	}
	return parts;
}

function blocksFromParts(parts) {
	const blocks = new Map();
	if (!Array.isArray(parts)) return blocks;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if ((part?.kind === "thinking" || part?.kind === "text") && typeof part.text === "string" && part.text.trim()) {
			blocks.set(index, { kind: part.kind, text: part.text });
		}
	}
	return blocks;
}

function reconcileBlocks(current, incoming) {
	if (incoming.size === 0) return cloneBlocks(current);
	const next = cloneBlocks(current);
	for (const [index, incomingBlock] of incoming.entries()) {
		const existing = next.get(index);
		if (!existing || existing.kind !== incomingBlock.kind) {
			next.set(index, { kind: incomingBlock.kind, text: incomingBlock.text });
			continue;
		}
		// Guard against stale shorter snapshots regressing a live stream, while
		// still accepting genuine provider rewrites/normalizations.
		const stalePrefix = existing.text.startsWith(incomingBlock.text) && incomingBlock.text.length < existing.text.length;
		next.set(index, {
			kind: existing.kind,
			text: stalePrefix ? existing.text : incomingBlock.text,
		});
	}
	return next;
}

function resolveContentIndex(blocks, kind, explicitIndex) {
	if (Number.isInteger(explicitIndex) && explicitIndex >= 0) return explicitIndex;
	const indices = [...blocks.keys()].sort((a, b) => a - b);
	for (let i = indices.length - 1; i >= 0; i -= 1) {
		const idx = indices[i];
		if (blocks.get(idx)?.kind === kind) return idx;
	}
	return indices.length > 0 ? indices[indices.length - 1] + 1 : 0;
}

function completedMessage(assistantMessageEvent) {
	if (!assistantMessageEvent || typeof assistantMessageEvent.type !== "string") return null;
	if (assistantMessageEvent.type === "done") return assistantMessageEvent.message ?? null;
	if (assistantMessageEvent.type === "error") return assistantMessageEvent.error ?? null;
	return null;
}

function applyAuthoritativeEnd(blocks, assistantMessageEvent) {
	const type = assistantMessageEvent?.type;
	if ((type !== "thinking_end" && type !== "text_end") || typeof assistantMessageEvent.content !== "string") {
		return blocks;
	}
	if (!assistantMessageEvent.content.trim()) return blocks;
	const kind = type === "thinking_end" ? "thinking" : "text";
	const index = resolveContentIndex(blocks, kind, assistantMessageEvent.contentIndex);
	const next = cloneBlocks(blocks);
	next.set(index, { kind, text: assistantMessageEvent.content });
	return next;
}

function applyPureDelta(blocks, assistantMessageEvent) {
	const type = assistantMessageEvent?.type;
	if (typeof type !== "string") return blocks;
	if ((type === "thinking_start" || type === "thinking_delta" || type === "text_start" || type === "text_delta")
		&& typeof assistantMessageEvent.delta === "string"
		&& assistantMessageEvent.delta.length > 0) {
		const kind = type.startsWith("thinking") ? "thinking" : "text";
		const index = resolveContentIndex(blocks, kind, assistantMessageEvent.contentIndex);
		const next = cloneBlocks(blocks);
		const existing = next.get(index);
		const text = existing?.kind === kind
			? appendDelta(existing.text, assistantMessageEvent.delta)
			: assistantMessageEvent.delta;
		next.set(index, { kind, text });
		return next;
	}
	return applyAuthoritativeEnd(blocks, assistantMessageEvent);
}

function normalizeStreamState(stream) {
	if (stream?.blocks instanceof Map) return stream;
	const blocks = blocksFromParts(stream?.parts ?? (Array.isArray(stream) ? stream : []));
	return { blocks, parts: projectParts(blocks) };
}

export function seedAssistantStream(message, assistantMessageEvent) {
	return updateAssistantStream(null, message, assistantMessageEvent);
}

export function updateAssistantStream(stream, message, assistantMessageEvent) {
	const current = normalizeStreamState(stream);
	const finalMessage = completedMessage(assistantMessageEvent);
	if (finalMessage) {
		const authoritative = extractIndexedBlocks(finalMessage.content);
		const blocks = authoritative.size > 0 ? authoritative : cloneBlocks(current.blocks);
		return { blocks, parts: projectParts(blocks) };
	}

	const type = assistantMessageEvent?.type;
	const partialBlocks = extractIndexedBlocks(assistantMessageEvent?.partial?.content);
	const messageBlocks = type === "start" ? new Map() : extractIndexedBlocks(message?.content);
	const snapshot = partialBlocks.size > 0 ? partialBlocks : messageBlocks;

	let blocks;
	if (snapshot.size > 0) {
		// Cumulative snapshot already incorporates the latest delta; never append
		// `delta` a second time on top of it.
		blocks = reconcileBlocks(current.blocks, snapshot);
		blocks = applyAuthoritativeEnd(blocks, assistantMessageEvent);
	} else {
		// Pure delta frame (empty partial shell): apply incremental delta/end.
		blocks = applyPureDelta(current.blocks, assistantMessageEvent);
	}

	return { blocks, parts: projectParts(blocks) };
}

export function finalizeAssistantStream(stream, message, assistantMessageEvent) {
	const current = normalizeStreamState(stream);
	if (assistantMessageEvent) {
		const merged = updateAssistantStream(current, message, assistantMessageEvent);
		if (merged.parts.length > 0) return merged;
	}
	const finalBlocks = extractIndexedBlocks(message?.content);
	if (finalBlocks.size > 0) {
		return { blocks: finalBlocks, parts: projectParts(finalBlocks) };
	}
	return { blocks: cloneBlocks(current.blocks), parts: projectParts(current.blocks) };
}

export function mergeParts(current, message, assistantMessageEvent) {
	return updateAssistantStream(current, message, assistantMessageEvent).parts;
}

export function assistantParts(message, assistantMessageEvent) {
	return updateAssistantStream(null, message, assistantMessageEvent).parts;
}

export function partsText(parts) {
	return parts.map((part) => part.text).join("\n");
}

export function partsSignature(parts) {
	return parts.map((part) => `${part.kind}:${part.text}`).join("\0");
}

/**
 * Build a synthetic native AssistantMessage for a child scope stream.
 *
 * Zero usage avoids spurious root token-usage rows or cache-miss markers;
 * `stopReason: "stop"` avoids triggering root error banners or tool-card
 * retraction; omitting `toolCall` blocks keeps the native assistant view live
 * until `message_end` without premature finalization.
 */
export function buildChildAssistantMessage(parts, { label = "", timestamp = Date.now() } = {}) {
	const content = parts.map((part) =>
		part.kind === "thinking"
			? { type: "thinking", thinking: part.text }
			: { type: "text", text: part.text },
	);
	return {
		role: "assistant",
		content,
		api: "herd-scope",
		provider: "herd",
		model: label || "scope",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp,
	};
}

/**
 * Build a safe delta event companion for `message_update`.
 *
 * Host listeners (`#vocalizeDelta`) read `assistantMessageEvent.type` without
 * optional chaining, and `type === "start"` restarts the assistant stream.
 * Emitting a typed delta event avoids both hazards.
 */
export function buildChildAssistantDelta(previousParts, nextParts, partial) {
	const prev = Array.isArray(previousParts) ? previousParts : [];
	const next = Array.isArray(nextParts) ? nextParts : [];
	let contentIndex = Math.max(0, next.length - 1);
	for (let index = next.length - 1; index >= 0; index -= 1) {
		const before = prev[index];
		const after = next[index];
		if (!before || before.kind !== after.kind || before.text !== after.text) {
			contentIndex = index;
			break;
		}
	}
	const target = next[contentIndex];
	const prior = prev[contentIndex];
	const kind = target?.kind === "thinking" ? "thinking" : "text";
	const delta = !target
		? ""
		: prior?.kind === target.kind && target.text.startsWith(prior.text)
			? target.text.slice(prior.text.length)
			: target.text;
	return {
		type: kind === "thinking" ? "thinking_delta" : "text_delta",
		contentIndex,
		delta,
		partial,
	};
}
