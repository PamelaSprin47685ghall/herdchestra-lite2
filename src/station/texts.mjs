// Station texts: every model-facing receipt string. The prose lives in
// resources/prompts/receipts/scope.md; this module chooses and composes it.

import { forkBudgetText } from "../scope/index.mjs";
import { listActiveScopePaths } from "../scope/path.mjs";
import { loadDoc, render } from "../prompts/index.mjs";

const T = loadDoc("receipts/scope");

function branchBudget(record, clock = null) {
	return forkBudgetText(record, Date.now(), clock) || "none";
}

/** The pin receipt: the note is saved. */
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

/** A steer when Root stops naturally under autopilot before finishing via scope_return. */
export function rootReturnNudge() {
	return T["root.return-nudge"];
}

export function skillReceiptText(
	state,
	branch = null,
	openCount = 0,
	child = false,
	clock = null,
	chineseReminder = "on",
) {
	const isChild = child || branch !== null;
	const lines = [];
	if (isChild) {
		// A forked scope always has a budget to report. When the ledger holds no
		// record for it, say the number is unknown instead of dropping the line:
		// an absent line reads as "nothing to watch".
		lines.push(
			branch
				? render(T["receipt.branch"], { budget: branchBudget(branch, clock) })
				: T["receipt.branch-missing"],
		);
	}
	if (openCount > 0) {
		lines.push(render(T["scope.unreceived"], { count: openCount }));
	}
	const relay = state?.relay;
	if (!isChild) {
		if (state?.autopilot) {
			lines.push(T["receipt.autopilot"]);
			if (openCount === 0) {
				const readyToAnswer = relay?.canStop === true || (Number.isInteger(relay?.bigStreak) && relay.bigStreak >= 2);
				lines.push(T[readyToAnswer ? "receipt.can-stop" : "receipt.return-required"]);
			}
		} else {
			lines.push(T["receipt.manual"]);
		}
	}
	const tree = scopeTreeText(state, branch);
	const status = `<skill version="1.0" enforced>${lines.join(" ")}</skill>`;
	const reminder = chineseReminder !== "off"
		? ` <skill version="1.0" enforced>${T["language"]}</skill>`
		: "";
	return `<additional-system-instructions>${status}${tree}${reminder}</additional-system-instructions>`;
}

function scopeTreeText(state, branch) {
	const ledger = state?.brackets;
	if (!ledger) return "";
	const selfPath = branch?.path ?? (branch?.scopeId ? `/${branch.scopeId}` : "/");
	const paths = listActiveScopePaths(ledger);
	return `<skill version="1.0" enforced>Scope tree:\nActive scopes (self: ${selfPath}):\n${paths.join("\n")}\n</skill>`;
}

export { amendText };
