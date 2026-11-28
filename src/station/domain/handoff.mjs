// Pure handoff and scope_return decisions for the Station.
//
// Owns the oath contract (`RETURN_OATH_KEY` / `RETURN_OATH_VALUE` /
// `RETURN_OATH_CONTINUE` / `RETURN_OATH_BREAK`), the unified Root + Subscope
// `scope_return` state transition table, and the reborn prompt /
// generation-report formatting.
// Pure functions only: no Station import, no host import, no mutation, no I/O.

import { copyRelay } from "../../relay/state.mjs";
import { renderChildRecord } from "../../transcript/replay.mjs";
import { loadDoc, render } from "../../prompts/index.mjs";

export const RETURN_OATH_KEY = "signed_sealed_hands_off_nothing_left_on_the_table";
export const RETURN_OATH_VALUE = "a_ferocious_audacious_master_would_change_nothing";
export const RETURN_OATH_CONTINUE = "continue";
export const RETURN_OATH_BREAK = "break";

function relayDoc() {
	return loadDoc("receipts/relay");
}

function trimString(value) {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Read the required oath field strictly (never truthy coercion).
 *
 * Three values only: `continue` rewinds, `break` is a degraded delivery, and the
 * seal value finishes at full standard. `big` survives for callers that only
 * need the seal/not-seal split.
 */
export function parseReturnOath(args) {
	const oath = args && typeof args === "object" ? args[RETURN_OATH_KEY] : undefined;
	if (oath === RETURN_OATH_VALUE) return { ok: true, mode: "seal", big: true };
	if (oath === RETURN_OATH_CONTINUE) return { ok: true, mode: "continue", big: false };
	if (oath === RETURN_OATH_BREAK) return { ok: true, mode: "break", big: false };
	return { ok: false, code: "INVALID_RETURN_OATH" };
}

/**
 * Unified `scope_return` decision across Root and Subscope.
 *
 * The oath is exactly one of three values:
 * - `continue` rewinds and carries the latest `dafny` forward. A rewind replays
 *   context only; it never refunds or re-mints a spent turn, budget, or clock.
 * - `break` is a degraded delivery. A non-root scope seals and delivers exactly
 *   like the seal value and owns its shortfall in `dafny`; Root rewinds instead,
 *   because a downgrade cannot seal Root.
 * - The seal value finishes the scope at full standard. At root, finishing sets
 *   `canStop` so the next turn is FINAL_ANSWER; root joins every outstanding
 *   child before a seal.
 *
 * When a non-root subscope has `record.abandonRequested === true`:
 * - Any oath (missing, invalid, `continue`, `break`, or seal) is accepted and
 *   NEVER rewinds.
 * - Immediately delivers to `receiverId` with `abandoned: true`.
 */
export function decideScopeReturn({
	isRoot = false,
	identityForkId = "",
	record = null,
	receiverId = "",
	orphans = [],
	unreceived = 0,
	relay = null,
	canRewindRoot = true,
	mixedToolCalls = false,
	args = {},
	callId = "",
} = {}) {
	const isAbandoned = !isRoot && record?.abandonRequested === true;

	const oath = isAbandoned ? { ok: true, mode: "seal", big: true } : parseReturnOath(args);
	if (!oath.ok) return { ok: false, code: oath.code };

	const dafny = trimString(args?.dafny);
	if (dafny === "") return { ok: false, code: "MISSING_DAFNY" };

	if (mixedToolCalls === true) {
		return { ok: false, code: "MIXED_RETURN_TOOL_CALLS" };
	}

	// Subscope (depth >= 1)
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
		if (!isAbandoned && oath.mode === "continue") {
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
			big: oath.mode === "seal",
			degraded: !isAbandoned && oath.mode === "break",
			abandoned: isAbandoned,
			dafny,
			receiverId,
			orphans: Array.isArray(orphans) ? orphans : [],
			stopLoop: true,
		};
	}

	// Root scope (depth === 0)
	const current = copyRelay(relay);
	const openCount = Number.isInteger(unreceived) && unreceived > 0 ? unreceived : 0;
	if (oath.mode === "seal" && openCount > 0) {
		return { ok: false, code: "UNRECEIVED_CHILDREN", unreceived: openCount };
	}
	if (oath.mode === "seal") {
		return {
			ok: true,
			kind: "promote",
			scope: "root",
			big: true,
			dafny,
			relay: {
				...current,
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
	const downgraded = oath.mode === "break";
	const pendingRewind = {
		report: "",
		generation: nextGeneration,
		...(downgraded ? { downgraded: true } : {}),
		...(typeof callId === "string" && callId !== "" ? { id: callId } : {}),
	};
	return {
		ok: true,
		kind: "rewind",
		scope: "root",
		big: false,
		downgraded,
		dafny,
		relay: {
			...current,
			generation: nextGeneration,
			canStop: false,
			pendingRewind,
		},
		pendingRewind,
		stopLoop: true,
	};
}

export function formatGenerationReport(messages, start = 0, dafny = "") {
	const body = renderChildRecord(Array.isArray(messages) ? messages : [], { start });
	const closing = trimString(dafny);
	if (closing === "") return body;
	return body === "" ? closing : `${body}\n\n${closing}`;
}

export function formatRebornPrompt({
	birth = "",
	report = "",
	downgraded = false,
} = {}) {
	const R = relayDoc();
	const sections = [];
	const birthText = trimString(birth);
	if (birthText !== "") sections.push(birthText);

	const reportText = trimString(report);
	if (reportText !== "") {
		sections.push(render(R["reborn.report"], { report: reportText }));
	}

	sections.push(R["reborn.continue"]);
	// A Root `break` cannot seal, so the reborn turn must end on the user's
	// verdict. This is the last line the next generation reads.
	const downgradedText = trimString(R["reborn.downgraded"]);
	if (downgraded === true && downgradedText !== "") sections.push(downgradedText);
	return sections.join("\n\n---\n\n");
}

export function rebornStartPrompt() {
	return relayDoc()["reborn.start"];
}

export function resetRootPromotion(relay) {
	const current = copyRelay(relay);
	if (current.canStop === false) return { changed: false, relay: current };
	return {
		changed: true,
		relay: {
			...current,
			canStop: false,
		},
	};
}
