// The conversation head every outbound request starts with.
//
// The data is a checked-in copy of one real exchange: a user question, the
// assistant's thinking, and the answer that followed. Every part is kept
// verbatim. Every request prepends that round, so the provider sees the same
// first turn on every call. Read once at module scope and cached: no I/O
// inside a station method.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = new URL("../../../resources/first-turn.json", import.meta.url);

/** Absolute path of the checked-in first round, for diagnostics. */
export const SHARED_FIRST_TURN_PATH = fileURLToPath(FILE);

let cached;

function fail(message, cause) {
	throw new Error(message, cause === undefined ? undefined : { cause });
}

/** Load the frozen first round as frozen `{ role, content }` messages. */
export function loadSharedFirstTurn() {
	if (cached !== undefined) return cached;

	let raw;
	try {
		raw = readFileSync(FILE, "utf8");
	} catch (error) {
		throw fail("Missing resources/first-turn.json", error);
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw fail("resources/first-turn.json is not valid JSON", error);
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new TypeError("resources/first-turn.json must hold a non-empty array");
	}

	cached = Object.freeze(
		parsed.map((message) => {
			if (message === null || typeof message !== "object") {
				throw new TypeError("first-turn message must be an object");
			}
			if (message.role !== "user" && message.role !== "assistant") {
				throw new TypeError(
					`first-turn message has an unsupported role: ${String(message.role)}`,
				);
			}
			if (!Array.isArray(message.content) || message.content.length === 0) {
				throw new TypeError("first-turn message must carry a content array");
			}
			const content = message.content.map((part) => {
				if (part === null || typeof part !== "object") {
					throw new TypeError("first-turn content part must be an object");
				}
				if (part.type !== "text" && part.type !== "thinking") {
					throw new TypeError(
						`first-turn content part has an unsupported type: ${String(part.type)}`,
					);
				}
				const body = part.type === "text" ? part.text : part.thinking;
				if (typeof body !== "string" || body.length === 0) {
					throw new TypeError(
						`first-turn ${part.type} part must carry its text`,
					);
				}
				return Object.freeze({ ...part });
			});
			return Object.freeze({ role: message.role, content: Object.freeze(content) });
		}),
	);
	return cached;
}
