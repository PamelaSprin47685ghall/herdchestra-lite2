// Folding port: the keep-list and the collapse decision.
//
// Two implementations. `on` accumulates notes and folds them through the amend
// contract it is handed, so a beat that amend retired can never come back.
// `off` folds nothing and keeps nothing; it still answers the same shape.
//
// The port never imports amend: the retired-key lookup arrives as `retired`,
// a function the composition root passes in. That is the bill-split direction
// in code, not in prose.

function refusal(code) {
	return { ok: false, code, port: "folding" };
}

/** `on`: accumulate notes, filter retired keys at fold time. */
export function foldingOn() {
	const notes = [];
	return {
		name: "on",
		note(entry) {
			if (!entry || typeof entry.key !== "string") return refusal("FOLDING_INVALID_ENTRY");
			notes.push({ ...entry });
			return { ok: true, accepted: notes.length };
		},
		fold({ retired = () => [] } = {}) {
			const gone = new Set(retired());
			const kept = notes.filter((entry) => !gone.has(entry.key));
			const folded = notes.length - kept.length;
			notes.length = 0;
			return { ok: true, folded, dropped: [...gone].filter((key) => !kept.some((e) => e.key === key)) };
		},
		kept() {
			return notes.map((entry) => entry.key);
		},
	};
}

/** `off`: the same methods, no accumulation, no rewrite. */
export function foldingOff() {
	return {
		name: "off",
		note() {
			return { ok: true, accepted: 0 };
		},
		fold() {
			return { ok: true, folded: 0, dropped: [] };
		},
		kept() {
			return [];
		},
	};
}

export const FOLDING_IMPLEMENTATIONS = { on: foldingOn, off: foldingOff };
