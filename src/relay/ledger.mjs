// Relay ledger: todo snapshot accounting and generation advances.
// Pure functions. No I/O.

import {
	copyRelay,
	finiteNumber,
	isPlainObject,
	nonNegativeInteger,
} from "./state.mjs";

/**
 * A todo view is the one ledger call that changes nothing. The native todo
 * infers `view` when no op is given and no list replaces the ledger; the relay
 * gate uses the same rule, or a diagnostic view is blocked exactly when the
 * relay is stuck.
 */
export function isTodoView(params) {
	const value = isPlainObject(params) ? params : {};
	if (value.op === "view") return true;
	if (value.op !== undefined) return false;
	return !Array.isArray(value.list);
}

function tasksOf(phase) {
	if (!isPlainObject(phase)) return [];
	if (Array.isArray(phase.tasks)) return phase.tasks;
	if (Array.isArray(phase.items)) return phase.items;
	return [];
}

/**
 * Count a canonical native todo snapshot. `details.phases` uses
 * `{ name, tasks }`; the `init` argument shape uses `{ phase, items }`. Both
 * are accepted because a snapshot can arrive through either path.
 */
export function ledgerStats(phases) {
	let total = 0;
	let open = 0;
	let blocked = 0;
	let completed = 0;
	let abandoned = 0;
	for (const phase of Array.isArray(phases) ? phases : []) {
		for (const task of tasksOf(phase)) {
			if (typeof task !== "string" && !isPlainObject(task)) continue;
			total += 1;
			const status =
				typeof task === "string" ? "pending" : task?.status ?? "pending";
			if (status === "completed") {
				completed += 1;
			} else if (status === "abandoned") {
				abandoned += 1;
			} else {
				open += 1;
				if (status === "blocked") blocked += 1;
			}
		}
	}
	return {
		empty: open === 0,
		open,
		blocked,
		completed,
		abandoned,
		total,
	};
}

function normalizedStats(stats, relay) {
	if (isPlainObject(stats) && typeof stats.empty === "boolean") return stats;
	const fallback = relay?.lastLedger;
	if (isPlainObject(fallback) && typeof fallback.empty === "boolean") return fallback;
	return null;
}

/**
 * Advance the relay after one successful native todo result.
 *
 * The two-step promotion is the whole protocol: generation 0 can never stop on
 * an empty ledger, and a successor can stop only when its FIRST evaluation is
 * empty. A successor that first reports work must hand off again later.
 */
export function applyLedgerEvaluation(relay, phases, options = {}) {
	const current = copyRelay(relay);
	const stats = ledgerStats(phases);
	const op = options.op;
	// A view is a read-only inspection, not a submitted ledger. It neither
	// promotes a successor nor changes the ledger. Only a successful write
	// operation's full snapshot counts as an evaluation.
	if (options.isError === true || op === "view") {
		return { relay: current, stats, action: null, changed: false };
	}
	const at = finiteNumber(options.at) ? options.at : Date.now();
	const lastLedger = { ...stats, at };
	const first = current.firstEvaluation === null;
	if (stats.empty) {
		// The successor's FIRST empty evaluation ends the chain and returns the
		// session to simple mode. A later empty write by that promoted holder is
		// a new ledger submission: it must not force another handoff, but it
		// turns the full flow back on. The holder keeps `canStop`, so it may
		// still write the final answer; a new scope invalidates the promotion
		// and the stage gate applies again.
		const promoted =
			current.generation > 0 &&
			!current.promotionInvalidated &&
			(first || current.canStop === true);
		if (promoted) {
			const terminating = first;
			return {
				relay: {
					...current,
					firstEvaluation: "empty",
					canStop: true,
					handoffPending: false,
					promotionInvalidated: false,
					handoffError: null,
					lastLedger,
					fullFlow: !terminating,
				},
				stats,
				action: terminating ? "promoted" : "reopened",
				changed: true,
			};
		}
		return {
			relay: {
				...current,
				firstEvaluation: first ? "empty" : current.firstEvaluation,
				canStop: false,
				handoffPending: true,
				lastLedger,
				fullFlow: true,
			},
			stats,
			action: "handoff",
			changed: true,
		};
	}
	return {
		relay: {
			...current,
			firstEvaluation: first ? "nonempty" : current.firstEvaluation,
			canStop: false,
			handoffPending: false,
			promotionInvalidated:
				current.promotionInvalidated || current.canStop === true,
			lastLedger,
			fullFlow: true,
		},
		stats,
		action: first ? "rework" : "continue",
		changed: true,
	};
}

export function beginGenerationAfterHandoff(relay, options = {}) {
	const current = copyRelay(relay);
	const at = finiteNumber(options.at) ? options.at : Date.now();
	return {
		...current,
		generation: current.generation + 1,
		firstEvaluation: null,
		canStop: false,
		handoffPending: false,
		promotionInvalidated: false,
		handoffError: null,
		lastHandoff: {
			at,
			fromGeneration: nonNegativeInteger(options.fromGeneration)
				? options.fromGeneration
				: current.generation,
			ok: true,
		},
	};
}

export function invalidatePromotion(relay) {
	if (relay?.canStop !== true) return relay;
	return {
		...copyRelay(relay),
		canStop: false,
		promotionInvalidated: true,
	};
}

export function recordHandoffFailure(relay, error, options = {}) {
	const current = copyRelay(relay);
	const message = String(error?.message ?? error ?? "handoff failed");
	const at = finiteNumber(options.at) ? options.at : Date.now();
	return {
		...current,
		handoffPending: false,
		handoffError: message,
		lastHandoff: {
			at,
			fromGeneration: current.generation,
			ok: false,
			error: message,
		},
	};
}

export { normalizedStats };
