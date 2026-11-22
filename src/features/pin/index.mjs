// Pin port: a session-level notebook.
//
// Two implementations, one shape. `on` keeps notes; `off` refuses every call
// with the same code, because a silent success would let a caller believe a
// note was kept.

export const PIN_UNAVAILABLE = "PIN_UNAVAILABLE";
export const PIN_INTERNAL_ERROR = "PIN_INTERNAL_ERROR";

function refusal() {
	return { ok: false, code: PIN_UNAVAILABLE, port: "pin" };
}

/**
 * `store` is the caller's persistent list. The port reads and writes it
 * directly so a session restore sees the same notes the port returned; an
 * internal array would silently fork the notebook on reload.
 */
export function createPinOn(store = { notes: [] }) {
	const notes = store.notes;
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
