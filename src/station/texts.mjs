// Station texts: every model-facing scope string. Pure. No I/O.

import { budgetText, currentScope } from "../scope/index.mjs";

function beginText(scope) {
	return [
		"You are now inside this scope.",
		`Intent: ${scope.intent}`,
		`Budget (innermost scope only): ${budgetText(scope) || "none"}.`,
		"Only the innermost scope's budget is used. A tool not listed in the budget has zero budget calls. scope, regret, defer, and pin are free.",
		"todo is free but forbidden inside any active scope. Close every scope before updating the ledger; a natural stop requires a successful todo evaluation outside all scopes.",
		"Calls in one assistant message spend at most one unit in total, split across the tools used in proportion to their call counts and rounded to two decimals. A tool whose balance runs out is blocked while the rest of the message still runs. Budget and spend by assistant turns.",
		"Do not write the final user-facing answer while inside a scope. Close every scope first; only after every scope closes may you answer the user.",
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
) {
	const lines = [];
	if (transitioning) {
		lines.push("Scope closed.");
	} else if (remainingScope) {
		lines.push(
			`Scope closed. You are back inside the enclosing scope: ${remainingScope.intent} (remaining budget: ${budgetText(remainingScope) || "none"}).`,
		);
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
		if (remainingScope) {
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

function insideScopeNudge(state) {
	const scope = currentScope(state);
	if (!scope) return "";
	return `You are still inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Do not write the final user-facing conclusion. Continue the task or close it with scope({ end: true }). Close all scopes before using todo. Only after the relay allows stopping may you write the final user-facing answer.`;
}

/** Dynamic, persistent receipt. Appended to history only when text changes. */
export function skillReceiptText(state, relayOn = true) {
	const scope = currentScope(state);
	const lines = scope
		? [
			`You are inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Remaining budget (innermost scope only): ${budgetText(scope) || "none"}.`,
		]
		: ["You are outside all scopes."];
	if (relayOn) {
		lines.push("Before stopping, call todo to evaluate the ledger; finishing is not a tool call.");
	} else if (!scope) {
		lines.push("Finishing is not a tool call.");
	}
	return `<skill version="1.0">${lines.join(" ")}</skill>`;
}

function insideScopeText(state) {
	const scope = currentScope(state);
	if (!scope) return "";
	return `You are still inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Do not write the final user-facing conclusion. Continue the task or close the scope. todo is forbidden inside every scope; close every scope before evaluating the ledger.`;
}

export {
	beginText,
	endText,
	regretText,
	insideScopeNudge,
	insideScopeText,
};
