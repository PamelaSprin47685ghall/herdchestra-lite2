// Pin port: a session-level notebook.
//
// Two implementations, one shape. `on` keeps notes; `off` refuses every call
// with the same code, because a silent success would let a caller believe a
// note was kept.

export const PIN_UNAVAILABLE = "PIN_UNAVAILABLE";

function refusal() {
	return { ok: false, code: PIN_UNAVAILABLE, port: "pin" };
}

export function createPinOn() {
	const notes = [];
	return {
		add(note) {
			if (typeof note !== "string" || note.trim() === "") {
				return { ok: false, code: "INVALID_NOTE", port: "pin" };
			}
			notes.push(note);
			return { ok: true, count: notes.length };
		},
		list() {
			return { ok: true, notes: notes.slice() };
		},
	};
}

export function createPinOff() {
	return {
		add() {
			return refusal();
		},
		list() {
			return refusal();
		},
	};
}
