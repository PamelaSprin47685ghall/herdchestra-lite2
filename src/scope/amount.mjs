// Display formatting for charge amounts.
//
// A leaf module: `turns.mjs`, `ledger-charge.mjs`, `ledger-brackets.mjs` and
// `ledger-serialize.mjs` all render amounts, and none of them may import
// `turns.mjs`, which reads the scope state. Keeping the formatter here keeps
// the ledger free of that edge.

/** Render an amount with the fixed two-decimal display precision. */
export function formatAmount(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}
