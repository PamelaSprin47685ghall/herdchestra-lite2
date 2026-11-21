/**
 * Synchronous transcript operations for one branch.
 *
 * A shared SessionManager keeps one active leaf for the whole journal. A fork
 * child holds its own manager proxy, and every append must be aimed at that
 * branch's tail without leaving the shared leaf moved afterwards. This module
 * owns that one operation; message copying between branches was retired with
 * the branch handoff.
 */

function selectLeaf(sm, id) {
	if (id == null) sm.resetLeaf();
	else sm.branch(id);
}

// getConversationTip() can skip metadata. The branch ends at the real leaf.
function leafId(sm) {
	const branch = sm.getBranch();
	return branch.at(-1)?.id ?? null;
}

/**
 * Run one write with the journal leaf aimed at `tail`, then restore the leaf
 * the caller had. The write must be synchronous: an async write would read
 * the leaf after this scope restored it.
 */
export function appendAt(sm, tail, write) {
	const saved = leafId(sm);
	let value;
	let failure;
	let failed = false;
	try {
		selectLeaf(sm, tail);
		value = write();
		if (value && typeof value.then === "function") {
			throw new TypeError("appendAt requires a synchronous write");
		}
	} catch (error) {
		failed = true;
		failure = error;
	}
	try {
		selectLeaf(sm, saved);
		if (leafId(sm) !== saved) throw new Error("leaf not restored");
	} catch (error) {
		throw new AggregateError(failed ? [failure, error] : [error], "leaf restore failed");
	}
	if (failed) throw failure;
	return value;
}
