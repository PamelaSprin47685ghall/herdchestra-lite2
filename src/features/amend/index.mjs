// Amend port: the beat ledger and the budget refund that belongs to it.
//
// `retired()` is the fact folding asks for: a beat that was amended must not
// come back through any later rewrite. `off` refuses, because a silent no-op
// would leave the caller believing the beat was retracted.

export const AMEND_UNAVAILABLE = "AMEND_UNAVAILABLE";

function refusal() {
	return { ok: false, code: AMEND_UNAVAILABLE, port: "amend" };
}

export function createAmendOn() {
	const retired = new Set();
	return {
		record(beatKey) {
			if (typeof beatKey !== "string" || beatKey === "") {
				return { ok: false, code: "INVALID_BEAT", port: "amend" };
			}
			retired.add(beatKey);
			return { ok: true, retired: [...retired] };
		},
		refund(beatKey) {
			// A refund only makes sense for a beat this ledger knows.
			if (!retired.has(beatKey)) {
				return { ok: false, code: "UNKNOWN_BEAT", port: "amend" };
			}
			return { ok: true, refunded: true };
		},
		retired() {
			return [...retired];
		},
	};
}

export function createAmendOff() {
	return {
		record() {
			return refusal();
		},
		refund() {
			return refusal();
		},
		retired() {
			return refusal();
		},
	};
}
