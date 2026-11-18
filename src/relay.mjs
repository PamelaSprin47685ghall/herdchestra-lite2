// Relay state machine and every model-facing relay text. Pure functions:
// no I/O, no host objects, no clocks beyond an optional injected `at`.
//
// The invariant: a natural stop is legal only after an empty ledger triggers a
// real /handoff and the successor's FIRST todo evaluation is also empty. Every
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
	};
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
		// A holder that is already promoted remains allowed to stop. A repeated
		// empty evaluation must not force another handoff: the promoted holder is
		// the one that writes the final answer.
		const promoted =
			current.generation > 0 &&
			!current.promotionInvalidated &&
			(first || current.canStop === true);
		if (promoted) {
			return {
				relay: {
					...current,
					firstEvaluation: "empty",
					canStop: true,
					handoffPending: false,
					promotionInvalidated: false,
					handoffError: null,
					lastLedger,
				},
				stats,
				action: "promoted",
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

function evaluationLabel(relay) {
	if (relay.firstEvaluation === null) return "not evaluated yet";
	if (relay.firstEvaluation === "empty") return "empty ledger";
	return "non-empty ledger";
}

function nextStepText(relay, stats, action) {
	switch (action) {
		case "promoted":
			return "The successor's first todo evaluation is an empty ledger. This promotion is the only state that allows a natural stop. Write the final user-facing answer as ordinary assistant text now.";
		case "handoff":
			return relay.generation === 0 && relay.firstEvaluation === "empty"
				? "The ledger is empty. Finish your reply to the user now; do not call another tool. The runtime runs the real built-in AgentSession.handoff() after this turn."
				: "The ledger is empty. The next context hook runs the real built-in AgentSession.handoff() and interrupts this turn. Do not call another tool.";
		case "rework":
			return relay.generation === 0
				? "Your first todo evaluation found open work (rework). Work through the ledger; a non-empty ledger forbids a natural stop."
				: "Your first todo evaluation as successor found open work. You are in rework and you are not the last holder: finish the work, and when the ledger becomes empty, stop so the runtime's session_stop hook can hand off to the next successor. Even then you may not stop; the next successor's first evaluation must also be empty.";
		case "continue":
			return "The ledger still has open work. Continue those items and evaluate the ledger again with todo. You may not stop while the ledger is non-empty.";
		default:
			return stats
				? "This result did not advance the relay evaluation. A todo view is read-only and does not submit the ledger. Use a write operation (init/append/start/done/...) to submit; only a successful write operation's full snapshot counts."
				: "No successful todo evaluation is recorded. Call todo outside all scopes before stopping.";
	}
}

export function relayStatusText(relay, stats, options = {}) {
	const current = copyRelay(relay);
	const ledger = normalizedStats(stats, current);
	const lines = [
		"RELAY STATE",
		`Generation: ${current.generation} (${current.generation === 0 ? "original holder" : "successor"}).`,
		`First todo evaluation of this generation: ${evaluationLabel(current)}.`,
	];
	if (ledger) {
		lines.push(
			`Ledger: ${ledger.empty ? "empty" : "non-empty"} (${ledger.total} total; ${ledger.open} open; ${ledger.blocked} blocked; ${ledger.completed} completed; ${ledger.abandoned} abandoned).`,
		);
	} else {
		lines.push("Ledger: not evaluated yet.");
	}
	lines.push(`Can stop now: ${current.canStop ? "yes" : "no"}.`);
	if (current.promotionInvalidated) lines.push("Promotion invalidated: yes.");
	if (current.handoffPending) {
		lines.push(
			"Handoff pending: yes. Do not change the ledger and do not open a scope; wait for the successor.",
		);
	}
	if (current.handoffError) lines.push(`Last handoff error: ${current.handoffError}`);
	if (options.error) lines.push(`This call did not advance the relay: ${options.error}`);
	lines.push(`Next: ${nextStepText(current, ledger, options.action ?? null)}`);
	return lines.join("\n");
}

const STOP_RULE =
	"A natural stop is allowed only in one sequence: an empty ledger triggers a real call to the built-in /handoff to a successor, and the successor's first todo evaluation is also empty. In every case where stopping is not allowed, keep working; never stop silently.";

// The successor must audit the previous holder instead of trusting an empty
// ledger. These steps are deliberately concrete and repeat in both prompts.
const INDEPENDENT_AUDIT_EN = [
	"Independent verification steps (mandatory):",
	"1. You must independently verify the previous holder's work. Do not trust its empty ledger or its conclusion.",
	"2. Re-read the user's original request; inspect the repository, the actual diff, and the tests.",
	"3. Run the relevant tests yourself; look for omitted, stubbed, falsely marked-complete, or silently narrowed work.",
	"4. An empty ledger is a claim to audit, not evidence. If you find any gap, write it into todo and rework.",
].join("\n");

const VERBATIM_REQUIREMENTS_REMINDER =
	"Friendly reminder: preserve the user's original requirements verbatim when handing off. Do not paraphrase, compress, or narrow them; retelling is where requirements drift. Quote the exact request in the ledger and in the handoff focus.";

const SUCCESSOR_RULE =
	"An empty ledger triggers a relay handoff: make a real call to the built-in /handoff and hand the successor prompt to the successor. The successor may first open any number of scopes to investigate, then make its first todo evaluation; todo does not have to be its first tool call. Only a successor whose first todo evaluation is an empty ledger may stop naturally. If successor A's first evaluation is a non-empty ledger, A enters rework; after that, even if A changes the ledger to empty, A is not the last holder and must call /handoff again to B; only when B's first todo evaluation is empty is stopping allowed.";

export function handoffFocus(relay) {
	const current = copyRelay(relay);
	return [
		"Relay: empty-ledger handoff.",
		SUCCESSOR_RULE,
		STOP_RULE,
		INDEPENDENT_AUDIT_EN,
		VERBATIM_REQUIREMENTS_REMINDER,
		`Previous generation: ${current.generation}. Its ledger was empty when it called the built-in /handoff.`,
		"Your first real task is an independent audit of that empty ledger. Do not trust the previous holder blindly: check whether unfinished user-requested work was marked completed or abandoned.",
		"You may open any number of scopes to investigate before your first todo evaluation; todo need not be your first tool call. todo itself is forbidden inside every scope. Close every scope before calling todo.",
		"Write every ledger item at a granularity where the next agent understands the work from the ledger alone: the verbatim user requirement, the evidence that proves it, the unresolved risk, and the next concrete action.",
		"Only your first todo evaluation being an empty ledger promotes you and allows a natural stop. If it is non-empty, you enter rework and must hand off again later; you are not the last holder.",
		"A todo view is a read-only check; it is NOT a submitted ledger. Only a successful write operation's full snapshot counts as your first submission.",
	].join("\n");
}

export function successorPrompt(relay, stats) {
	const current = copyRelay(relay);
	const ledger = normalizedStats(stats, current);
	return [
		`You are the relay successor (generation ${current.generation}). The previous holder's ledger was empty, so it called the real built-in /handoff and handed the work to you.`,
		SUCCESSOR_RULE,
		STOP_RULE,
		INDEPENDENT_AUDIT_EN,
		VERBATIM_REQUIREMENTS_REMINDER,
		"You may first open any number of scopes to investigate. todo does not have to be your first tool call. But todo is forbidden inside every scope; close all scopes before you call todo.",
		"Your first todo evaluation decides everything: empty -> you are promoted and may write the final user-facing answer; non-empty -> rework, you are not the last holder, and after finishing the work an empty ledger must trigger another real /handoff to the next successor.",
		"A todo view is a read-only check; it is NOT a submitted ledger. Only a successful write operation's full snapshot counts as your first submission.",
		"You have no /handoff tool to call. When the ledger is empty, stop; the runtime's session_stop hook performs the real AgentSession.handoff().",
		"Write the ledger so the next agent understands the whole work from the ledger alone: verbatim user requirements, acceptance evidence, unresolved risks, and the next concrete action.",
		relayStatusText(current, ledger),
	].join("\n\n");
}

export function firstEvaluationNudge() {
	return [
		"You are outside all scopes, so todo is available and is the only functional tool you may call. Before stopping, evaluate the ledger with todo. You may open scopes first to investigate, but todo must be called after every scope closes.",
		"A todo view is a read-only check; it is NOT a submitted ledger. Only a successful write operation's full snapshot counts as your first submission.",
		STOP_RULE,
		"Do not write the final user-facing answer until the relay reaches a promoted empty-ledger successor evaluation.",
	].join("\n");
}

export function openLedgerNudge(relay, stats) {
	return [
		"You are outside all scopes. The ledger is not empty, so a natural stop is forbidden.",
		relayStatusText(relay, stats),
		"Continue the open items, close every scope, then evaluate the ledger again with todo.",
	].join("\n\n");
}

export function handoffPendingNudge(relay) {
	return [
		"A relay handoff is pending. Do not change the ledger, do not open a scope, and do not write the final answer; wait for the successor.",
		relayStatusText(relay, relay?.lastLedger ?? null),
		"If the host did not actually start the handoff, the runtime retries the real AgentSession.handoff() method. Never substitute message text, newSession, or a nudge for it.",
	].join("\n\n");
}

export function handoffFailureNudge(error) {
	const message = String(error?.message ?? error ?? "unknown error");
	return [
		`HANDOFF FAILED: ${message}`,
		"Do not pretend the handoff succeeded, and do not degrade to sendUserMessage, newSession, or a text note. The relay runtime will retry the real AgentSession.handoff() method. Do not stop.",
		STOP_RULE,
	].join("\n");
}
