// Isomorphic transcript predicates: one answer on both sides of the bridge.
//
// The TUI station builds display groups from branch entries; the web client
// builds them from frames. Both must agree on where a turn starts, or the same
// session reads differently in the two views.

/**
 * True for a message the user actually typed.
 *
 * A skill receipt, a steer note or a child's report also has `role: "user"`;
 * only real typing starts a turn. `synthetic` marks an input the host injected,
 * which is why the check is here and not only in the station: the web client
 * groups the same messages and must not split a turn on an injected note.
 */
export function isRealUser(item) {
	return item?.role === "user" && item?.attribution === "user" && item?.synthetic !== true;
}
