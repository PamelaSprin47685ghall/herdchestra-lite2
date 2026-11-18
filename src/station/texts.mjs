// Station texts: every model-facing scope string. Pure. No I/O.

import { budgetText, currentScope } from "../scope/index.mjs";
import { languageSkill, outsideScopeInstruction } from "../host/prompts.mjs";

function beginText(scope) {
	return [
		"You are now inside this scope.",
		`Intent: ${scope.intent}`,
		`Budget (innermost scope only): ${budgetText(scope) || "none"}.`,
		"Only the innermost scope's budget is used. A tool not listed in the budget has zero budget calls. scope, regret, defer, and pin are free.",
		"todo is free but forbidden inside any active scope. Close every scope before updating the ledger; a natural stop requires a successful todo evaluation outside all scopes.",
		"Calls in one assistant message spend at most one unit in total, split across the tools used in proportion to their call counts and rounded to two decimals. A tool whose balance runs out is blocked while the rest of the message still runs. Budget and spend by assistant turns.",
		"Do not write the final user-facing answer while inside a scope. Close every scope first; only after every scope closes may you answer the user.",
		"When this scope closes, its elder sibling at the same level is collapsed; this scope stays visible until a younger sibling closes.",
		'Call scope({ end: { return_markdown: "<report for your future self>" } }) when this task is complete. return_markdown is a self-delivery report; write the user-facing answer as ordinary assistant text.',
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
				"todo cannot be called inside any scope. Before finishing, close every enclosing scope, then call todo to update the ledger. A non-empty ledger forbids stopping; an empty ledger must trigger the real /handoff protocol.",
			);
		} else {
			lines.push(
				"Call todo now to evaluate the ledger before writing the final user-facing answer. A non-empty ledger forbids stopping; an empty ledger must trigger the real /handoff protocol.",
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

function budgetLine(scope) {
	return scope ? budgetText(scope) || "none" : "none";
}

function scopeTailInstruction(state) {
	const scope = currentScope(state);
	if (!scope) return outsideScopeInstruction;
	return `You are inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Remaining budget (innermost scope only): ${budgetLine(scope)}. Only the innermost scope's budget is used; scope, regret, defer, and pin are free. todo is free but forbidden inside any active scope; close every scope before updating the ledger. Calls in one assistant message share at most one unit, split across the tools used in proportion to their call counts and rounded to two decimals; a tool whose balance runs out is blocked while the rest of the message still runs. Do not write the final user-facing answer while inside a scope. When this task is complete, call scope({ end: { return_markdown: "<report for your future self>" } }). If an enclosing scope remains, you will return inside it; only when every scope is closed may you write the final answer as ordinary assistant text. Finishing is not a tool call.`;
}

const outsideScopeInstructionNoRelay =
	"You are outside all scopes. Only the free control tools (scope, regret, defer, pin) may be called here; todo is unavailable in this session. Finishing is not a tool call.";

function scopeTailInstructionNoRelay(state) {
	const scope = currentScope(state);
	if (!scope) return outsideScopeInstructionNoRelay;
	return `You are inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Remaining budget (innermost scope only): ${budgetLine(scope)}. Only the innermost scope's budget is used; scope, regret, defer, and pin are free. Calls in one assistant message share at most one unit, split across the tools used in proportion to their call counts and rounded to two decimals; a tool whose balance runs out is blocked while the rest of the message still runs. Do not write the final user-facing answer while inside a scope. When this task is complete, call scope({ end: { return_markdown: "<report for your future self>" } }). If an enclosing scope remains, you will return inside it; only when every scope is closed may you write the final answer as ordinary assistant text. Finishing is not a tool call.`;
}

/** The exact outbound user tail: additional-system-instructions + language skill. */
export function tailText(state, relayOn = true) {
	return [
		`<additional-system-instructions><skill version="1.0">${relayOn ? scopeTailInstruction(state) : scopeTailInstructionNoRelay(state)}</skill></additional-system-instructions>`,
		`<system-reminder>${languageSkill}</system-reminder>`,
	].join("\n\n");
}

function insideScopeNudge(state) {
	const scope = currentScope(state);
	if (!scope) return "";
	return `You are still inside scope level ${state.scopes.length}: ${JSON.stringify(scope.intent)}. Do not write the final user-facing conclusion yet. Continue the task; when it is complete, close this scope with scope({ end: { return_markdown: "<report for your future self>" } }). todo is forbidden inside every scope, so close this scope and every enclosing scope before updating the ledger. Only outside all scopes may you write the final answer as ordinary assistant text, and only after a promoted empty-ledger successor evaluation. If you are permanently blocked, close the scope with a return_markdown report explaining the block, then answer outside only after the relay evaluation.`;
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
	budgetLine,
	scopeTailInstruction,
	insideScopeNudge,
	insideScopeText,
};
