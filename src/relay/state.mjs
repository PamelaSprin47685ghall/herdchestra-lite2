// Relay state: creation, copying, and validation. Pure data. No I/O.
//
// Root handoff is unified with `scope_return` and matches a subscope:
// - `continue` rewinds Root to its user prompts + report and increments
//   `generation`; `canStop` stays false.
// - `break` rewinds Root the same way and marks the pending rewind `downgraded`,
//   so the reborn turn says the previous generation delivered below standard.
// - The seal value sets `canStop = true`, so Root writes the final user-facing
//   answer without another rewind.
//
// A rewind refunds nothing: `pendingRewind` carries a report, a generation, and
// at most the degraded marker. Budgets and clocks never live here.
//
// `isPlainObject` here is the strict predicate: a relay value this process built
// must carry this realm's `Object.prototype`, so a value that crossed a realm is
// refused before a rewind can depend on it. `core/primitives.mjs` holds both
// spellings; the scope layer takes the tolerant one.

import { isLocalPlainObject as isPlainObject } from "../core/primitives.mjs";

function nonNegativeInteger(value) {
	return Number.isInteger(value) && value >= 0;
}

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function copyPendingRewind(value) {
	if (!isPlainObject(value)) return null;
	if (typeof value.report !== "string") return null;
	if (!nonNegativeInteger(value.generation)) return null;
	return {
		report: value.report,
		generation: value.generation,
		...(value.downgraded === true ? { downgraded: true } : {}),
		...(typeof value.id === "string" && value.id !== "" ? { id: value.id } : {}),
	};
}

function isValidPendingRewind(value) {
	if (value === null || value === undefined) return true;
	if (!isPlainObject(value)) return false;
	if (typeof value.report !== "string") return false;
	if (!nonNegativeInteger(value.generation)) return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	if (value.downgraded !== undefined && typeof value.downgraded !== "boolean") return false;
	return true;
}

export function createRelay() {
	return {
		generation: 0,
		canStop: false,
		// One-shot goal session: set by `/herd-goal`, cleared on sealed delivery.
		goal: false,
		// Official goal fallback: set with `goal` when `/herd-goal` also enters
		// omp's built-in goal mode, cleared when that official goal settles.
		goalFallback: false,
		// Verbatim user-authored prompts and steers, oldest first. Preserved
		// across Root rewinds and reloads so the reborn Root always starts from
		// the complete user requirement record.
		userPrompts: [],
		pendingRewind: null,
	};
}

export function copyRelay(relay) {
	const source = isPlainObject(relay) ? relay : createRelay();
	return {
		generation: nonNegativeInteger(source.generation) ? source.generation : 0,
		canStop: source.canStop === true,
		goal: source.goal === true,
		goalFallback: source.goalFallback === true,
		userPrompts: Array.isArray(source.userPrompts)
			? source.userPrompts.filter(
					(text) => typeof text === "string" && text.trim() !== "",
				)
			: [],
		pendingRewind: copyPendingRewind(source.pendingRewind),
	};
}

export function isValidRelay(value) {
	if (!isPlainObject(value)) return false;
	if (!nonNegativeInteger(value.generation)) return false;
	if (typeof value.canStop !== "boolean") return false;
	if (value.goal !== undefined && typeof value.goal !== "boolean") return false;
	if (value.goalFallback !== undefined && typeof value.goalFallback !== "boolean") {
		return false;
	}
	if (value.userPrompts !== undefined) {
		if (!Array.isArray(value.userPrompts)) return false;
		for (const text of value.userPrompts) {
			if (typeof text !== "string") return false;
		}
	}
	if (!isValidPendingRewind(value.pendingRewind)) return false;
	return true;
}

export { isPlainObject, nonNegativeInteger, finiteNumber };
