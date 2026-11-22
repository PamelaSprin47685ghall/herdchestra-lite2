// Station texts: every model-facing receipt string. The prose lives in
// resources/prompts/receipts/scope.md; this module chooses and composes it.

import { forkBudgetText } from "../scope/index.mjs";
import { handoffDemand } from "../relay/index.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

function hasDemand(message, demand, exact) {
	if (message?.excludeFromContext === true) return false;
	const { content } = message;
	const matches = (text) => typeof text === "string" &&
		(exact ? text === demand : text.includes(demand));
	return typeof content === "string" ? matches(content) :
		Array.isArray(content) && content.some((block) => block?.type === "text" && matches(block.text));
}

export function handoffDemandVisible(relay, history) {
	if (!relay?.handoffPending || !history) return false;
	const demand = handoffDemand();
	for (const message of history.pending) {
		if (message?.role === "user" && hasDemand(message, demand, true)) return true;
	}
	// A natural-stop prompt in committed history must be new input, not a
	// prompt the model has answered. A todo result identifies its generation.
	let newInput = true;
	for (let index = history.prefix.length - 1; index >= 0; index -= 1) {
		const message = history.prefix[index];
		if (message?.role === "assistant") newInput = false;
		if (message?.role === "user" && newInput && hasDemand(message, demand, true)) return true;
		const reported = message?.details?.relay;
		if (message?.role === "toolResult" && message.toolName === "todo" && message.isError !== true &&
			reported?.generation === relay.generation && reported.handoffPending === true &&
			reported.lastLedger?.at === relay.lastLedger?.at && hasDemand(message, demand, false)) return true;
	}
	return false;
}

const T = loadDoc("receipts/scope");

function branchBudget(record, clock = null) {
	return forkBudgetText(record, Date.now(), clock) || "none";
}

/** The pin receipt: the note is saved, and the ledger may now be stale. */
export const PIN_SAVED_TEXT = T["pin.saved"];

function amendText(applied, record = null, clock = null) {
	const refunded = Number.isInteger(applied.refunded) ? applied.refunded : 0;
	const text = render(T["amend.undone"], { refunded });
	return record ? `${text}\n${render(T["amend.remaining"], { budget: branchBudget(record, clock) })}` : text;
}

/** A steer when a branch tries to stop with unreceived work. */
export function insideScopeNudge(openCount) {
	return render(T["scope.stop-blocked"], { count: openCount });
}

export function skillReceiptText(state, relayOn = true, branch = null, openCount = 0, demandVisible = false, child = false, clock = null) {
	const isChild = child || branch !== null;
	const lines = [];
	if (isChild && branch) {
		lines.push(render(T["receipt.branch"], { budget: branchBudget(branch, clock) }));
	}
	if (openCount > 0) {
		lines.push(render(T["scope.unreceived"], { count: openCount }));
	}
	const relay = state.relay;
	const fullFlow = relayOn && relay?.fullFlow === true;
	if (!isChild && state.autopilot && fullFlow && relay.firstEvaluation === null) {
		lines.push(T["receipt.no-ledger"]);
	}
	if (!isChild && state.autopilot && relayOn && relay?.viewRequired && !relay.handoffPending) {
		lines.push(T["receipt.view-required"]);
	}
	if (!isChild) {
		if (state.autopilot) {
			lines.push(T["receipt.autopilot"]);
		} else {
			lines.push(T["receipt.manual"]);
		}
	}
	if (state.autopilot && !isChild && relayOn) {
		if (relay?.handoffPending) {
			if (openCount > 0) lines.push(T["receipt.close-handoff"]);
			else if (!demandVisible) lines.push(handoffDemand());
		} else if (openCount === 0) {
			lines.push(T[relay?.canStop ? "receipt.can-stop" : fullFlow ? "receipt.todo" : "receipt.simple-outside"]);
		}
	}
	return `<skill version="1.0">${lines.join(" ")}</skill>`;
}

export { amendText };
