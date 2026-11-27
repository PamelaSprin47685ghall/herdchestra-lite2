// Pure handoff and scope_return decisions for the Station.
//
// Owns the oath contract (`RETURN_OATH_KEY` / `RETURN_OATH_VALUE` /
// `RETURN_OATH_UNFINISHED`), the unified
// Root + Child `scope_return` state transition table, and the reborn prompt /
// generation-report formatting. Pure functions only: no Station import, no host
// import, no mutation of inputs, no I/O.

import { copyRelay } from "../../relay/state.mjs";
import { renderChildRecord } from "../../transcript/replay.mjs";
import { loadDoc, render } from "../../prompts/index.mjs";

export const RETURN_OATH_KEY = "signed_sealed_hands_off_nothing_left_on_the_table";
export const RETURN_OATH_VALUE = "a_ferocious_audacious_master_would_change_nothing";
export const RETURN_OATH_UNFINISHED = "unfinished";

function relayDoc() {
	return loadDoc("receipts/relay");
}

function trimString(value) {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the required oath field strictly (never truthy coercion). Exactly one
 * of two values is accepted:
 * - `RETURN_OATH_UNFINISHED`: small handoff (`big: false`), a rewind.
 * - `RETURN_OATH_VALUE`: big handoff (`big: true`), a seal.
 * A missing field, `undefined`, `null`, `""`, `false`, or a typo is refused
 * with `INVALID_RETURN_OATH`: there is no default path.
 */
export function parseReturnOath(args) {
	const oath = args && typeof args === "object" ? args[RETURN_OATH_KEY] : undefined;
	if (oath === RETURN_OATH_VALUE) return { ok: true, big: true };
	if (oath === RETURN_OATH_UNFINISHED) return { ok: true, big: false };
	return { ok: false, code: "INVALID_RETURN_OATH" };
}

/**
 * Unified `scope_return` decision across Root and Child scopes.
 *
 * Pure: validates arguments, batch exclusivity, scope state, unreceived
 * children, and Root rewind capability before any state mutates.
 *
 * Returns one of:
 * - `{ ok: false, code, ... }`
 * - `{ ok: true, kind: "rewind", scope: "child", dafny, stopLoop: true }`
 * - `{ ok: true, kind: "deliver", scope: "child", dafny, receiverId, orphans, stopLoop: true }`
 * - `{ ok: true, kind: "rewind", scope: "root", big, dafny, relay, pendingRewind, stopLoop: true }`
 * - `{ ok: true, kind: "promote", scope: "root", dafny, relay, stopLoop: false }`
 */
export function decideScopeReturn({
	isRoot = false,
	identityForkId = "",
	record = null,
	receiverId = "",
	orphans = [],
	unreceived = 0,
	relay = null,
	review = "on",
	canRewindRoot = true,
	mixedToolCalls = false,
	args = {},
	callId = "",
} = {}) {
	const oath = parseReturnOath(args);
	if (!oath.ok) return { ok: false, code: oath.code };

	const dafny = trimString(args?.dafny);
	if (dafny === "") return { ok: false, code: "MISSING_DAFNY" };

	if (mixedToolCalls === true) {
		return { ok: false, code: "MIXED_RETURN_TOOL_CALLS" };
	}

	// Child scope (depth >= 1)
	if (!isRoot) {
		if (typeof identityForkId !== "string" || identityForkId === "") {
			return { ok: false, code: "NOT_A_CHILD" };
		}
		if (!record || typeof record !== "object") {
			return { ok: false, code: "UNKNOWN_FORK" };
		}
		if (record.status !== "running") {
			return {
				ok: false,
				code: "FORK_NOT_RUNNING",
				status: record.status,
			};
		}
		if (!oath.big) {
			return {
				ok: true,
				kind: "rewind",
				scope: "child",
				big: false,
				dafny,
				stopLoop: true,
			};
		}
		if (typeof receiverId !== "string" || receiverId === "") {
			return { ok: false, code: "ORPHANS_WITHOUT_RECEIVER" };
		}
		return {
			ok: true,
			kind: "deliver",
			scope: "child",
			big: true,
			dafny,
			receiverId,
			orphans: Array.isArray(orphans) ? orphans : [],
			stopLoop: true,
		};
	}

	// Root scope (depth === 0)
	const current = copyRelay(relay);
	const openCount = Number.isInteger(unreceived) && unreceived > 0 ? unreceived : 0;
	if (oath.big && openCount > 0) {
		return { ok: false, code: "UNRECEIVED_CHILDREN", unreceived: openCount };
	}
	if (oath.big && current.bigStreak >= 1) {
		return {
			ok: true,
			kind: "promote",
			scope: "root",
			big: true,
			dafny,
			relay: {
				...current,
				bigStreak: 2,
				canStop: true,
				pendingRewind: null,
			},
			stopLoop: false,
		};
	}
	// Review off: the first seal is the review. Promote instead of
	// spending a compaction rewind on a second look.
	if (oath.big && review === "off") {
		return {
			ok: true,
			kind: "promote",
			scope: "root",
			big: true,
			dafny,
			relay: {
				...current,
				bigStreak: 1,
				canStop: true,
				pendingRewind: null,
			},
			stopLoop: false,
		};
	}
	if (canRewindRoot !== true) {
		return { ok: false, code: "ROOT_REWIND_UNAVAILABLE" };
	}
	const nextGeneration = current.generation + 1;
	const pendingRewind = {
		report: "",
		big: oath.big,
		generation: nextGeneration,
		...(typeof callId === "string" && callId !== "" ? { id: callId } : {}),
	};
	return {
		ok: true,
		kind: "rewind",
		scope: "root",
		big: oath.big,
		dafny,
		relay: {
			...current,
			generation: nextGeneration,
			bigStreak: oath.big ? 1 : 0,
			canStop: false,
			pendingRewind,
		},
		pendingRewind,
		stopLoop: true,
	};
}

/**
 * Render the current generation's assistant text + tool calls (with args),
 * excluding amended beats and appending the trimmed `dafny`.
 *
 * Shared by Child final return, Child rewind, and Root rewind so tool calls
 * always travel into the next generation or calling scope automatically.
 */
export function formatGenerationReport(messages, start = 0, dafny = "") {
	const body = renderChildRecord(Array.isArray(messages) ? messages : [], { start });
	const closing = trimString(dafny);
	if (closing === "") return body;
	return body === "" ? closing : `${body}\n\n${closing}`;
}

/**
 * Render the reborn handoff prompt/summary shared by Root and Child rewinds.
 *
 * - For Child: `birth` is the original birth `spec.receipt`; the result is sent
 *   as one single `user` message directly off `originEntryId`.
 * - For Root: `birth` is omitted (user prompts and steers are restored as real
 *   verbatim `user` messages right after the compaction boundary); the result
 *   is stored as the compaction summary.
 */
export function formatRebornPrompt({
	birth = "",
	report = "",
	big = false,
} = {}) {
	const R = relayDoc();
	const sections = [];
	const birthText = trimString(birth);
	if (birthText !== "") sections.push(birthText);

	const reportText = trimString(report);
	if (reportText !== "") {
		sections.push(render(R["reborn.report"], { report: reportText }));
	}

	sections.push(big ? R["reborn.review"] : R["reborn.continue"]);
	return sections.join("\n\n---\n\n");
}

/** The neutral resume cue delivered to a reborn Root after compaction commits. */
export function rebornStartPrompt() {
	return relayDoc()["reborn.start"];
}

/**
 * Pure check for resetting Root's promotion streak when new work starts
 * (a new real user prompt/steer or a newly opened fork).
 */
export function resetRootPromotion(relay) {
	const current = copyRelay(relay);
	if (current.bigStreak === 0 && current.canStop === false) return { changed: false, relay: current };
	return {
		changed: true,
		relay: {
			...current,
			bigStreak: 0,
			canStop: false,
		},
	};
}
