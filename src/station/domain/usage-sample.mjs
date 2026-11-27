// Usage sampling: the arithmetic a station needs between the measured usage
// ledger and the projections it prints.
//
// The ledger itself (`../../scope/usage-ledger.mjs`) owns what the host reported.
// What lives here is the small reduction of those readings into the numbers the
// capability projection and the directory snapshot quote, so the station does
// not recompute them in three places.
//
// Pure: numbers in, numbers out.

/**
 * The occupancy of the last request: input plus output, or null when no request
 * has been measured.
 *
 * Output is optional because a provider may report input only; sending a
 * request costs its input either way, and the caller must not lose that number
 * to a missing output count.
 */
export function measuredOccupancy(usage) {
	const input = usage?.lastTotalInput;
	if (!Number.isFinite(input)) return null;
	const output = usage?.lastOutputTokens;
	return input + (Number.isFinite(output) ? output : 0);
}

/** The baseline the session started at, or null when none was recorded. */
export function baselineOf(usage) {
	const baseline = usage?.baselineTokens;
	return Number.isFinite(baseline) ? baseline : null;
}

/** True when this message closes a request window: one assistant reply. */
export function closesRequest(message) {
	return message?.role === "assistant";
}

/**
 * The sample bookkeeping a station keeps outside the ledger: the model key of
 * the last closed request, and which message objects it has already counted.
 *
 * Identity, not `startedAt`, is what stops a late copy of the same assistant
 * message from closing the next request; the caller supplies the set, because a
 * station already owns one.
 */
export function createSampleState() {
	return { modelKey: "" };
}

/** Remember the model that closed this sample; an empty key changes nothing. */
export function noteSampleModel(state, key) {
	if (typeof key === "string" && key !== "") state.modelKey = key;
	return state.modelKey;
}
