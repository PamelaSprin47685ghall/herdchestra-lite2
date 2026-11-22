// Pure abandon gate. The ledger mutation stays in scope/forkjoin.mjs.
//
// `abandon` drops a fork without a result when its parent is cancelled. The
// only decision is whether the record can be abandoned at all; the caller
// owns the sequence bump and the queue removal.

export function decideAbandon({ record = null } = {}) {
	if (!record || typeof record !== "object") {
		return { ok: false, code: "UNKNOWN_FORK" };
	}
	if (record.status === "joined") {
		return { ok: false, code: "FORK_ALREADY_JOINED" };
	}
	return { ok: true, status: "failed" };
}
