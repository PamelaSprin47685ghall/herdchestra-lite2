// Station texts: every model-facing scope string. Pure. No I/O.

import { budgetText, currentScope } from "../scope/index.mjs";
import { DECISION_FRAMING } from "../scope/stages.mjs";
import { handoffToolBlockedReason } from "../relay/index.mjs";

function stageLine(scope) {
	if (scope.stage === "direct-execution") {
		return "Stage: direct-execution. This stage has no stage prompt; follow the orchestration-plan artifact.";
	}
	return `Stage: ${scope.stage}. Follow the [Stage: ${scope.stage}] section in your system prompt; the other stage sections do not apply inside this scope.`;
}

function beginText(scope) {
	const framing = scope.stage === DECISION_FRAMING;
	return [
		"You are now inside this scope.",
		`Intent: ${scope.intent}`,
		stageLine(scope),
		`Budget (innermost scope only): ${budgetText(scope) || "none"}.`,
		"Only the innermost scope's budget is used. An unlisted budgeted tool has zero budget calls. scope, regret, defer, pin, ask, and wait are free where allowed.",
		"todo is free but forbidden inside any active scope. Close every scope before updating the ledger.",
		"Calls in one assistant message spend at most one unit in total, split across budgeted tools by call count and rounded to two decimals. A tool whose balance runs out is blocked while the rest of the message still runs.",
		framing
			? "While herd mode is on, you may stop here to wait for the user's input."
			: "Do not write the final user-facing answer while inside a scope. Close every scope first.",
		"Close with scope({ end: true }). This scope stays visible as the hot workbench. When opening its next sibling, pass its summary in begin.elder_report.",
	].join("\n");
}

function endText(
	report,
	foldedReport,
	deferredCount,
	steerText,
	steerSent,
	transitioning = false,
	remainingScope = null,
	relayOn = true,
	herdMode = false,
) {
	const lines = [];
	if (transitioning) {
		lines.push("Scope closed.");
	} else if (remainingScope) {
		lines.push(
			`Scope closed. You are back inside the enclosing scope: ${remainingScope.intent} (remaining budget: ${budgetText(remainingScope) || "none"}).`,
		);
		if (remainingScope.stage) lines.push(stageLine(remainingScope));
	} else {
		lines.push("Scope closed. You are outside all scopes.");
	}
	if (foldedReport !== null) {
		lines.push(
			`Your elder sibling scope at this level was collapsed; its begin receipt now reads: ${foldedReport}`,
		);
	} else {
		lines.push("No elder sibling scope was collapsed.");
	}
	lines.push(
		`This scope keeps its internal turns until a younger sibling scope closes; its begin receipt will then read: ${report}`,
	);
	if (deferredCount > 0) {
		lines.push(
			steerSent
				? `${deferredCount} deferred finding(s) were delivered as a steering user message:`
				: `${deferredCount} deferred finding(s) follow:`,
		);
		lines.push(steerText);
	} else {
		lines.push("No deferred findings were recorded in this scope.");
	}
	if (relayOn) {
		if (remainingScope) {
			lines.push(
				"todo cannot be called inside any scope. Before finishing, close every enclosing scope, then call todo to update the ledger. A non-empty ledger forbids stopping; an empty ledger triggers the relay handoff protocol.",
			);
		} else {
			lines.push(
				"Call todo now to evaluate the ledger before writing the final user-facing answer. A non-empty ledger forbids stopping; an empty ledger triggers the relay handoff protocol.",
			);
		}
	}
	if (!transitioning) {
		if (herdMode) {
			lines.push("Herd mode is on. You may stop and wait for the user's input.");
		} else if (remainingScope) {
			lines.push(
				"Do not write the final user-facing answer yet. Continue inside the enclosing scope, or close it when the whole task is complete. Finishing is not a tool call.",
			);
		} else if (relayOn) {
			lines.push(
				"You are outside all scopes. Only a promoted empty-ledger successor evaluation allows the final user-facing answer as ordinary assistant text. Do not put it in return_markdown. Finishing is not a tool call.",
			);
		} else {
			lines.push("You are outside all scopes. Finishing is not a tool call.");
		}
	}
	return lines.join("\n");
}

function regretText(applied) {
	const refunded = Number.isInteger(applied.refunded) ? applied.refunded : 0;
	const residual = Array.isArray(applied.residualDefers) ? applied.residualDefers.length : 0;
	const lines = [
		"Undid the previous beat. It will not appear in the next LLM request.",
		refunded > 0 ? `Refunded ${refunded} tool call(s).` : "No tool budget was refunded by that beat.",
		`Remaining: ${budgetText(applied.scope) || "none"}.`,
	];
	if (residual > 0) {
		lines.push(
			`${residual} defer finding(s) from that beat were withdrawn but remain valid; they will still be delivered when this scope ends.`,
		);
	}
	return lines.join("\n");
}

function leaveFramingText(scope) {
	return scope.stage === DECISION_FRAMING
		? " Herd mode is off. Leave decision-framing by closing this scope."
		: "";
}

function insideScopeNudge(state) {
	const scope = currentScope(state);
	if (!scope) return "";
	return `You are still inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}.${leaveFramingText(scope)} Do not write the final user-facing conclusion. Continue the task or close it with scope({ end: true }). Close all scopes before using todo. Only after the relay allows stopping may you write the final user-facing answer.`;
}

/** Dynamic, persistent receipt. Appended to history only when text changes. */
export function skillReceiptText(state, relayOn = true) {
	const scope = currentScope(state);
	const lines = scope
		? [
			`You are inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Remaining budget (innermost scope only): ${budgetText(scope) || "none"}.`,
		]
		: ["You are outside all scopes."];
	lines.push(`Herd mode: ${state.herdMode ? "on" : "off"}.`);
	if (scope?.stage) lines.push(`Stage: ${scope.stage}.`);
	if (state.herdMode) {
		lines.push('New scopes must use stage: "decision-framing". ask is allowed only when that stage is innermost. You may stop naturally to wait for the user.');
	} else if (relayOn) {
		if (scope?.stage === DECISION_FRAMING) lines.push("Close the decision-framing scope; herd mode is off.");
		if (state.relay?.handoffPending) {
			lines.push(scope ? "Close all scopes before writing the pending relay handoff report." : handoffToolBlockedReason());
		} else if (!scope && state.relay?.canStop) {
			lines.push("The relay allows you to stop. Write the final answer in your message body.");
		} else {
			lines.push("Before stopping, call todo to evaluate the ledger; finishing is not a tool call.");
		}
	} else if (!scope) {
		lines.push("Finishing is not a tool call.");
	}
	return `<skill version="1.0">${lines.join(" ")}</skill>`;
}

function insideScopeText(state) {
	const scope = currentScope(state);
	if (!scope) return "";
	return `You are still inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}.${leaveFramingText(scope)} Do not write the final user-facing conclusion. Continue the task or close the scope. todo is forbidden inside every scope; close every scope before evaluating the ledger.`;
}

export {
	beginText,
	endText,
	regretText,
	insideScopeNudge,
	insideScopeText,
};
