// Amend port: the beat ledger and the turn refund that belongs to it.
//
// `retired()` is the fact the amend filter asks for: a beat that was amended must not
// come back through any later rewrite. `off` refuses, because a silent no-op
// would leave the caller believing the beat was retracted.

export const AMEND_UNAVAILABLE = "AMEND_UNAVAILABLE";

function refusal() {
	return { ok: false, code: AMEND_UNAVAILABLE, port: "amend" };
}

/**
 * `store` is the caller's persistent list of retired beat keys. Keeping the
 * ledger in the caller's array is what lets a reload keep refusing to revive
 * a beat that was amended before the restart.
 */
export function createAmendOn(store = { retired: [] }) {
	const retired = store.retired;
	return {
		record(beatKey) {
			if (typeof beatKey !== "string" || beatKey === "") {
				return { ok: false, code: "INVALID_BEAT", port: "amend" };
			}
			if (!retired.includes(beatKey)) retired.push(beatKey);
			return { ok: true, retired: retired.slice() };
		},
		refund(beatKey) {
			// A refund only makes sense for a beat this ledger knows.
			if (!retired.includes(beatKey)) {
				return { ok: false, code: "UNKNOWN_BEAT", port: "amend" };
			}
			return { ok: true, refunded: true };
		},
		retired() {
			return retired.slice();
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
