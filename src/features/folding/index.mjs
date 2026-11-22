// Folding port: the keep-list and the collapse decision.
//
// Two implementations. `on` projects the elder fork/join receipts through the
// pure transcript helpers; `off` returns the messages untouched. The port
// carries no state: the station owns `receipts` and `messages`, and the
// projection is idempotent.
//
// `foldable` answers the receipts a pass may shorten; `apply` answers the
// projected messages and the ids it shortened. Both implementations answer the
// same shape, so the station never branches on the port name.

import { foldableReceipts } from "../../scope/receipts.mjs";
import { applyReceiptFolds } from "../../transcript/collapse.mjs";

/** `on`: the real projection. */
export function foldingOn() {
	return {
		name: "on",
		foldable(receipts) {
			return foldableReceipts(receipts);
		},
		apply(messages, receipts, options = {}) {
			return applyReceiptFolds(messages, receipts, options);
		},
	};
}

/** `off`: nothing is foldable, nothing is rewritten. */
export function foldingOff() {
	return {
		name: "off",
		foldable() {
			return [];
		},
		apply(messages) {
			return { messages, collapsed: [] };
		},
	};
}

export const FOLDING_IMPLEMENTATIONS = { on: foldingOn, off: foldingOff };
