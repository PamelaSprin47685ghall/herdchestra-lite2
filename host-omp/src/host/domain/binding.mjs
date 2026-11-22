// Pure owner/display decision for a station binding.
//
// The host executes the plan; this function only names what must happen. It
// imports nothing, so the rule is testable without a session, a UI or the
// activation layer.

/**
 * Plan the user-facing half of a station binding.
 *
 * - registerOwnerUI: the root session is the only user-facing surface, so a
 *   fork's approval appears there with the child's label.
 * - displayKind: which live display the station must read. A child carries its
 *   own holder or display; the root uses the owner session's display.
 */
export function planStationBinding({
	owner = null,
	childIdentity = null,
	hasUI = true,
	ui = null,
} = {}) {
	const isChild = Boolean(childIdentity);
	const registerOwnerUI = Boolean(owner) && !isChild && hasUI !== false && Boolean(ui);
	let displayKind = "none";
	if (childIdentity?.displayHolder) displayKind = "holder";
	else if (childIdentity?.display) displayKind = "child";
	else if (!isChild && hasUI !== false) displayKind = "owner";
	return { registerOwnerUI, displayKind };
}
