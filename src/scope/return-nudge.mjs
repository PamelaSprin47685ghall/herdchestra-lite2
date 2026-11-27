// The corrective prompt a child receives when it stops without returning.
//
// One text, two readers: the spawn ticket that delivers it, and the relay
// handoff that keeps it out of the user's archive. It is an instruction for
// one turn, not a requirement of the user. Pure. No I/O.
//
// The allowance is one field on the ledger record, because two independent
// paths spend it: the station's in-turn steer and the ticket's out-of-turn
// prompt. A bound that two paths can spend lives where both paths read.

import { loadDoc, render } from "../prompts/index.mjs";
import { editRecord } from "./record-mutation.mjs";

const S = loadDoc("receipts/scope");

/**
 * How many times a subscope that stopped without `scope_return` is asked again.
 */
export const MAX_RETURN_NUDGES = 2;

export function childReturnNudge() {
	return S["fork.subscope-return-nudge"];
}

export function abandonedReturnNudge({ by = "/", reason = null } = {}) {
	const cleanBy = typeof by === "string" && by !== "" ? by : "/";
	const reasonClause =
		typeof reason === "string" && reason.trim() !== ""
			? ` (${reason.trim()})`
			: "";
	return render(S["mode.abandoned"], { by: cleanBy, reasonClause });
}

/** Return nudges already given to this record; a record without the field has none. */
export function returnNudgesOf(record) {
	const used = record?.returnNudges;
	return Number.isInteger(used) && used > 0 ? used : 0;
}

/**
 * Charge one nudge to the record, or refuse when the allowance is spent.
 *
 * Both callers charge before asking the child again, so the child sees one
 * bound however the two paths interleave.
 */
export function takeReturnNudge(record) {
	if (!record || typeof record !== "object") return false;
	const used = returnNudgesOf(record);
	if (used >= MAX_RETURN_NUDGES) return false;
	// Spending the allowance is a record change: the two paths that charge it
	// read the same field, so a reload that missed this write would let a child
	// be asked again past the bound.
	return editRecord(record, (target) => {
		target.returnNudges = used + 1;
	});
}

/** A new requirement restarts the conversation, so it restarts the allowance. */
export function resetReturnNudges(record) {
	if (!record || typeof record !== "object") return;
	// Written unconditionally rather than skipped when already zero: a reset is
	// the start of a new requirement, and the journal has to hold that fact
	// even when the value happens to match.
	editRecord(record, (target) => {
		target.returnNudges = 0;
	});
}
