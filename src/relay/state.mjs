// Relay state: creation, copying, and validation. Pure data. No I/O.
//
// Root handoff is unified with `scope_return`:
// - A small handoff (oath omitted) rewinds Root to its user prompts + pins + report,
//   increments `generation`, and resets `bigStreak` to 0.
// - A first big handoff (oath present, `bigStreak === 0`) rewinds Root for an
//   independent review pass (`generation += 1`, `bigStreak = 1`, `canStop = false`).
// - A second consecutive big handoff (oath present, `bigStreak >= 1`) promotes
//   without rewinding (`bigStreak = 2`, `canStop = true`) so Root may write the
//   final user-facing answer.

function isPlainObject(value) {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

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
		big: value.big === true,
		generation: value.generation,
		...(typeof value.id === "string" && value.id !== "" ? { id: value.id } : {}),
	};
}

function isValidPendingRewind(value) {
	if (value === null || value === undefined) return true;
	if (!isPlainObject(value)) return false;
	if (typeof value.report !== "string") return false;
	if (typeof value.big !== "boolean") return false;
	if (!nonNegativeInteger(value.generation)) return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	return true;
}

export function createRelay() {
	return {
		generation: 0,
		bigStreak: 0,
		canStop: false,
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
		bigStreak: nonNegativeInteger(source.bigStreak) ? source.bigStreak : 0,
		canStop: source.canStop === true,
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
	if (value.bigStreak !== undefined && !nonNegativeInteger(value.bigStreak)) {
		return false;
	}
	if (typeof value.canStop !== "boolean") return false;
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
