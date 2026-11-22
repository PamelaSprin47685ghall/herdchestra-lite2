// The branch's own hand held out for more budget.
//
// Pure decision: no Station, no host, no I/O. This module owns only what the
// station alone can answer: is there a branch to ask, and did the model state
// a reason? The scope layer validates the grant itself, because it owns the
// account and the caps.
//
// A refusal always names a code. The handler owns the words.

export const PANHANDLE_TOOL = "scope_panhandle";

const RUNNING = "running";
const BLOCKED = "blocked";

function trimText(value) {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Decide whether this scope may hold out its hand at all.
 *
 * The caps, the tool shape and the clock check stay in `applyPanhandle`: the
 * ledger is the only authority on what a grant may contain. Duplicating those
 * rules here would let the two answers drift.
 */
export function decidePanhandle({ record = null, because = undefined } = {}) {
	if (!record || typeof record !== "object") {
		return { ok: false, code: "NO_BRANCH_BUDGET" };
	}
	if (record.status === BLOCKED) {
		return { ok: false, code: "PANHANDLE_BLOCKED" };
	}
	if (record.status !== RUNNING) {
		return { ok: false, code: "PANHANDLE_CLOSED" };
	}
	const reason = trimText(because);
	if (reason === "") {
		return { ok: false, code: "PANHANDLE_NO_REASON" };
	}
	return { ok: true, reason };
}
