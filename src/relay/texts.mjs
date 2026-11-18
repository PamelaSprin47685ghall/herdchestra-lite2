// Relay texts: every model-facing relay string. Pure functions. No I/O.

import { copyRelay } from "./state.mjs";
import { normalizedStats } from "./ledger.mjs";

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
