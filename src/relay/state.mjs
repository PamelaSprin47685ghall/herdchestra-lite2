// Relay state: creation, copying, and validation. Pure data. No I/O.
//
// The invariant: a natural stop is legal only after an empty ledger triggers a
// self-handoff and the successor's FIRST todo evaluation is also empty. Every
// other outside-scope stop must produce a nudge.

const FIRST_EVALUATIONS = new Set(["empty", "nonempty"]);

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

export function createRelay() {
	return {
		generation: 0,
		firstEvaluation: null,
		canStop: false,
		handoffPending: false,
		promotionInvalidated: false,
		handoffError: null,
		lastLedger: null,
		lastHandoff: null,
		fullFlow: false,
	};
}

function legacyFullFlow(source) {
	if (typeof source.fullFlow === "boolean") return source.fullFlow;
	// Older snapshots had no switch. A promoted holder had already finished its
	// line; any line that started a generation, armed a handoff, or submitted a
	// ledger was in the full flow.
	if (source.canStop === true) return false;
	return (
		(nonNegativeInteger(source.generation) && source.generation > 0) ||
		source.handoffPending === true ||
		FIRST_EVALUATIONS.has(source.firstEvaluation)
	);
}

function copyLedger(ledger) {
	if (!isPlainObject(ledger)) return null;
	return {
		empty: ledger.empty === true,
		open: nonNegativeInteger(ledger.open) ? ledger.open : 0,
		blocked: nonNegativeInteger(ledger.blocked) ? ledger.blocked : 0,
		completed: nonNegativeInteger(ledger.completed) ? ledger.completed : 0,
		abandoned: nonNegativeInteger(ledger.abandoned) ? ledger.abandoned : 0,
		total: nonNegativeInteger(ledger.total) ? ledger.total : 0,
		at: finiteNumber(ledger.at) ? ledger.at : 0,
	};
}

function copyLastHandoff(lastHandoff) {
	if (!isPlainObject(lastHandoff)) return null;
	const copied = {
		at: finiteNumber(lastHandoff.at) ? lastHandoff.at : 0,
		fromGeneration: nonNegativeInteger(lastHandoff.fromGeneration)
			? lastHandoff.fromGeneration
			: 0,
		ok: lastHandoff.ok === true,
	};
	if (typeof lastHandoff.error === "string") copied.error = lastHandoff.error;
	return copied;
}

export function copyRelay(relay) {
	const source = isPlainObject(relay) ? relay : createRelay();
	return {
		generation: nonNegativeInteger(source.generation) ? source.generation : 0,
		fullFlow: legacyFullFlow(source),
		firstEvaluation: FIRST_EVALUATIONS.has(source.firstEvaluation)
			? source.firstEvaluation
			: null,
		canStop: source.canStop === true,
		handoffPending: source.handoffPending === true,
		promotionInvalidated: source.promotionInvalidated === true,
		handoffError:
			typeof source.handoffError === "string" ? source.handoffError : null,
		lastLedger: copyLedger(source.lastLedger),
		lastHandoff: copyLastHandoff(source.lastHandoff),
	};
}

export function isValidRelay(value) {
	if (!isPlainObject(value)) return false;
	if (!nonNegativeInteger(value.generation)) return false;
	if (value.fullFlow !== undefined && typeof value.fullFlow !== "boolean") {
		return false;
	}
	if (
		value.firstEvaluation !== null &&
		!FIRST_EVALUATIONS.has(value.firstEvaluation)
	) {
		return false;
	}
	if (typeof value.canStop !== "boolean") return false;
	if (typeof value.handoffPending !== "boolean") return false;
	if (typeof value.promotionInvalidated !== "boolean") return false;
	if (
		value.handoffError !== null &&
		typeof value.handoffError !== "string"
	) {
		return false;
	}
	if (value.lastLedger !== null) {
		const ledger = value.lastLedger;
		if (!isPlainObject(ledger)) return false;
		if (typeof ledger.empty !== "boolean") return false;
		for (const field of ["open", "blocked", "completed", "abandoned", "total"]) {
			if (!nonNegativeInteger(ledger[field])) return false;
		}
		if (!finiteNumber(ledger.at)) return false;
	}
	if (value.lastHandoff !== null) {
		const last = value.lastHandoff;
		if (!isPlainObject(last)) return false;
		if (!finiteNumber(last.at)) return false;
		if (!nonNegativeInteger(last.fromGeneration)) return false;
		if (typeof last.ok !== "boolean") return false;
		if (last.error !== undefined && typeof last.error !== "string") return false;
	}
	return true;
}

export { isPlainObject, nonNegativeInteger, finiteNumber };
