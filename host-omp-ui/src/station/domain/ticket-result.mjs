// One rule set for what a ticket result means. A ticket answers; this module
// says which answers commit state and which ones travel to a client.
//
// Two callers share it, so neither may own it: the Station commits the `meta`
// outcome itself (its commit already broadcasts), and the wiring carries the
// receipt and the toast out. Splitting the rule across both callers meant a new
// outcome kind had to be added twice, and that the "meta is already committed"
// invariant had no single home.

/**
 * Interpret a ticket result into broadcast decisions. Pure: no station, no host.
 *
 * @returns {{ outcomes: Array<{kind: "meta", patch: object} | {kind: "receipt", clientId: string, requestId: string, ok: boolean, code?: string} | {kind: "toast", level: string, message: string}> }}
 */
export function ticketResultOutcomes(event, result) {
	const outcomes = [];
	const { clientId, requestId } = event?.payload ?? {};
	if (result?.ok !== false && result?.reported) {
		outcomes.push({ kind: "meta", patch: result.reported });
	}
	if (clientId && requestId) {
		outcomes.push({ kind: "receipt", clientId, requestId, ok: result?.ok !== false, code: result?.code });
	}
	if (result?.ok === false) {
		outcomes.push({ kind: "toast", level: "error", message: `${event.type}: ${result.code ?? "failed"}` });
	}
	return { outcomes };
}

/**
 * Commit the outcomes that are state, hand back the ones that are transport.
 * `commit` is the Station's own meta commit, injected so this stays pure.
 */
export function commitTicketResult(commit, event, result) {
	const { outcomes } = ticketResultOutcomes(event, result);
	const rest = [];
	for (const outcome of outcomes) {
		// A meta patch is a state commit, and the commit broadcasts its own frame:
		// the wiring must not send it a second time.
		if (outcome.kind === "meta") commit(outcome.patch);
		else rest.push(outcome);
	}
	return { outcomes: rest };
}
