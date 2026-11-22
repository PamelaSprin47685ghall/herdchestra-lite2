// The relay port: three degrees of obligation, one shape.
//
// `none` owes nothing. `ledger` owes a ledger and forbids a silent stop.
// `handoff` adds the transfer: a promotion, a self-compaction and the right to
// advance into the next holder.
//
// Every implementation answers the same four methods with the same shapes, so
// the wiring never asks which one it holds. The port is synchronous; the
// scheduling that reads these answers belongs to tickets.

/** A refusal every relay implementation can return. */
function refusal(code, detail) {
	return { ok: false, code, port: "relay", detail };
}

/** The ledger shape a ticket may hand in. */
function normalizeLedger(input) {
	if (!input || typeof input !== "object") return null;
	const empty = input.empty === true;
	const open = Number.isInteger(input.open) ? input.open : 0;
	const total = Number.isInteger(input.total) ? input.total : open;
	return { empty, open, total };
}

/**
 * `none`: no obligation at all.
 *
 * It still answers every method, because the calling side must not branch on
 * which implementation it holds.
 */
export const relayNone = Object.freeze({
	name: "none",
	owesLedger() {
		return false;
	},
	canHandoff() {
		return false;
	},
	record() {
		return { ok: true, recorded: false };
	},
	status() {
		return { kind: "none", owes: false, canStop: true, ledger: null };
	},
	advance() {
		return refusal("RELAY_NOT_OWED", "this relay owes nothing, so there is nothing to advance");
	},
});

/**
 * `ledger`: a ledger must exist and must be non-empty before the holder stops.
 */
export const relayLedger = Object.freeze({
	name: "ledger",
	owesLedger() {
		return true;
	},
	canHandoff() {
		return false;
	},
	record(input) {
		const ledger = normalizeLedger(input);
		if (ledger === null) return refusal("INVALID_LEDGER", "record() expects a ledger object");
		return { ok: true, recorded: true, ledger };
	},
	status(ledger) {
		const current = normalizeLedger(ledger);
		if (current === null) {
			return { kind: "ledger", owes: true, canStop: false, ledger: null };
		}
		return { kind: "ledger", owes: true, canStop: current.empty === true, ledger: current };
	},
	advance() {
		return refusal("RELAY_NO_HANDOFF", "this relay holds a ledger but never hands off");
	},
});

/**
 * `handoff`: the ledger plus the right to advance into another holder.
 *
 * The advance is a decision, not an action: it says what the ticket should do
 * and leaves the scheduling to the caller.
 */
export const relayHandoff = Object.freeze({
	name: "handoff",
	owesLedger() {
		return true;
	},
	canHandoff() {
		return true;
	},
	record(input) {
		const ledger = normalizeLedger(input);
		if (ledger === null) return refusal("INVALID_LEDGER", "record() expects a ledger object");
		return { ok: true, recorded: true, ledger };
	},
	status(ledger) {
		const current = normalizeLedger(ledger);
		if (current === null) {
			return { kind: "handoff", owes: true, canStop: false, ledger: null };
		}
		return { kind: "handoff", owes: true, canStop: current.empty === true, ledger: current };
	},
	advance(ledger) {
		const current = normalizeLedger(ledger);
		if (current === null) {
			return refusal("RELAY_NO_LEDGER", "nothing has been recorded, so there is nothing to hand off");
		}
		if (current.empty !== true) {
			return refusal("RELAY_LEDGER_OPEN", "the ledger still has open work; a handoff would abandon it");
		}
		return { ok: true, kind: "handoff", next: "successor" };
	},
});

/** The implementation table, keyed by the names the port registry uses. */
export const relayImplementations = Object.freeze({
	none: relayNone,
	ledger: relayLedger,
	handoff: relayHandoff,
});
