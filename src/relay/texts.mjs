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
			return [
				"The ledger is empty. A relay handoff is now required.",
				"DO NOT call any more tools (including todo, scope, or any other tool). Any further tool call will be rejected.",
				"Write the handoff report immediately in your message body (use whatever format best fits the content). Include the user's requirements without omitting or narrowing them, completed work and verification evidence, unresolved risks, and anything the next generation needs to know to independently audit and continue.",
			].join(" ");
		case "rework":
			return relay.generation === 0
				? "Your first todo evaluation found open work (rework). Work through the ledger; a non-empty ledger forbids a natural stop."
				: "Your first todo evaluation as successor found open work. You are in rework and you are not the last holder: finish the work. When the ledger becomes empty, write a handoff report in your message body for the next successor. The next successor's first evaluation must also be empty for it to stop.";
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
			"Handoff pending: yes. Do not call any tools; write the handoff report directly in your message body.",
		);
	}
	if (current.handoffError) lines.push(`Last handoff error: ${current.handoffError}`);
	if (options.error) lines.push(`This call did not advance the relay: ${options.error}`);
	lines.push(`Next: ${nextStepText(current, ledger, options.action ?? null)}`);
	return lines.join("\n");
}

const STOP_RULE =
	"A natural stop is allowed only in one sequence: an empty ledger triggers a self-handoff (write the handoff report in your message body with no tool calls, followed by a compaction boundary for the successor), and the successor's first todo evaluation is also empty. In every case where stopping is not allowed, keep working; never stop silently.";

// The successor must audit the previous holder instead of trusting an empty
// ledger. These steps are deliberately concrete and repeat in both prompts.
const INDEPENDENT_AUDIT_EN = [
	"Independent verification steps (mandatory):",
	"1. You must independently verify the previous holder's work. Do not trust its empty ledger or its conclusion.",
	"2. Re-read the user's original request; inspect the repository, the actual diff, and the tests.",
	"3. Run the relevant tests yourself; look for omitted, stubbed, falsely marked-complete, or silently narrowed work.",
	"4. An empty ledger is a claim to audit, not evidence. If you find any gap, write it into todo and rework.",
].join("\n");

const REQUIREMENTS_REMINDER =
	"Summarize the user's requirements without omitting or narrowing them. You do not need to quote the original wording in the ledger or handoff summary.";

const SUCCESSOR_RULE =
	"An empty ledger triggers a relay handoff: the predecessor writes the handoff report directly in its message body, a compaction boundary is placed, and the successor takes over from that report. The successor may first open any number of scopes to investigate, then make its first todo evaluation; todo does not have to be its first tool call. Only a successor whose first todo evaluation is an empty ledger may stop naturally. If successor A's first evaluation is a non-empty ledger, A enters rework; after that, even if A changes the ledger to empty, A is not the last holder and must hand off again to B; only when B's first todo evaluation is empty is stopping allowed.";

export function handoffFocus(relay) {
	const current = copyRelay(relay);
	return [
		"Relay: empty-ledger handoff.",
		`Include these relay instructions in the handoff document for generation ${current.generation + 1}: the predecessor submitted an empty ledger; the successor must independently audit it before its first write to todo.`,
		SUCCESSOR_RULE,
		STOP_RULE,
		INDEPENDENT_AUDIT_EN,
		REQUIREMENTS_REMINDER,
		`Previous generation: ${current.generation}. Its ledger was empty when it called the built-in /handoff.`,
		"Your first real task is an independent audit of that empty ledger. Do not trust the previous holder blindly: check whether unfinished user-requested work was marked completed or abandoned.",
		"You may open any number of scopes to investigate before your first todo evaluation; todo need not be your first tool call. todo itself is forbidden inside every scope. Close every scope before calling todo.",
		"Write every ledger item so the next agent can understand the work: the user requirement, acceptance evidence, unresolved risks, and the next concrete action.",
		"Only your first todo evaluation being an empty ledger promotes you and allows a natural stop. If it is non-empty, you enter rework and must hand off again later; you are not the last holder.",
		"A todo view is a read-only check; it is NOT a submitted ledger. Only a successful write operation's full snapshot counts as your first submission.",
	].join("\n");
}

export function handoffToolBlockedReason() {
	return "RELAY_HANDOFF_PENDING: tool calls are forbidden during handoff. Do not call any tools; write your handoff report immediately in your message body.";
}

export function handoffEmptyReportNudge() {
	return [
		"RELAY_HANDOFF_PENDING: you have not written the handoff report yet.",
		"Do not call any tools. Write the handoff report immediately in your message body (format free-form to fit the content) covering user requirements, completed work and verification evidence, and unresolved risks.",
	].join("\n");
}

export function successorOpeningText(relay, report) {
	const current = copyRelay(relay);
	const nextGeneration = current.generation + 1;
	const trimmed = typeof report === "string" ? report.trim() : "";
	return [
		trimmed,
		"",
		"---",
		`Relay Handoff — Generation ${nextGeneration} Takeover:`,
		`Previous generation: ${current.generation}. Its ledger was empty when it wrote the handoff report above.`,
		SUCCESSOR_RULE,
		STOP_RULE,
		INDEPENDENT_AUDIT_EN,
		REQUIREMENTS_REMINDER,
		"You may open any number of scopes to investigate before your first todo evaluation; todo need not be your first tool call. todo itself is forbidden inside every scope. Close every scope before calling todo.",
		"Only your first todo evaluation being an empty ledger promotes you and allows a natural stop. If it is non-empty, you enter rework and must hand off again later; you are not the last holder.",
		"A todo view is a read-only check; it is NOT a submitted ledger. Only a successful write operation's full snapshot counts as your first submission.",
	].join("\n");
}

export function successorStartNudge(relay) {
	const current = copyRelay(relay);
	return `Generation ${current.generation} takeover: read the handoff report at the top of the compacted context and begin your independent audit now. Open scopes to verify the work if needed, then close all scopes and call todo to evaluate the ledger.`;
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
		"A relay handoff is pending. Do not call any tools; write the handoff report immediately in your message body.",
		relayStatusText(relay, relay?.lastLedger ?? null),
	].join("\n\n");
}

export function handoffFailureNudge(error) {
	const message = String(error?.message ?? error ?? "unknown error");
	return [
		`HANDOFF FAILED: ${message}`,
		"Do not stop. Write your handoff report in your message body with no tool calls.",
		STOP_RULE,
	].join("\n");
}
